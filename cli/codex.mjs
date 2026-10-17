import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRpc } from './codex-rpc.mjs';
import { applyCodexEvent, CODEX_EVENTS } from './codex-events.mjs';

const exec = promisify(execFile);
export const defaultCodexSocket = () => process.env.DAG_CODEX_SOCKET
  || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');

export class CodexAdapter {
  constructor({ rpc = socket => new CodexRpc(socket), execute = exec } = {}) {
    this.rpc = rpc; this.execute = execute;
  }

  async read(binding) {
    const rpc = await this.rpc(binding.socketPath).connect();
    try {
      const result = await rpc.request('thread/read', { threadId: binding.threadId });
      if (result.thread?.id !== binding.threadId) throw new Error('Codex returned a different thread ID.');
      return result.thread;
    } finally { rpc.close(); }
  }

  async submit(binding, text) {
    // Validate the exact binding before submitting; never resolve by title,
    // cwd, newest thread, or the sender's inherited CODEX_THREAD_ID.
    await this.read(binding);
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    if (binding.codexHome) env.CODEX_HOME = binding.codexHome;
    await this.execute(binding.executable || 'codex', ['queue', '--remote', `unix://${binding.socketPath}`,
      '--thread', binding.threadId, '--message', text], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
  }
}

/** Persist observations serially so late writes cannot undo newer events. */
export function observationSink(store, sessionId, rootId) {
  let chain = Promise.resolve();
  return {
    push(event) {
      if (!CODEX_EVENTS.has(event.method)) return Promise.resolve();
      chain = chain.then(() => store.locked(async state => {
        const session = state.sessions.find(s => s.id === sessionId);
        if (session?.codex?.threadId !== rootId) return;
        state.observations ||= {};
        const previous = state.observations[sessionId];
        const next = applyCodexEvent(previous, rootId, event);
        if (next !== previous) { state.observations[sessionId] = next; await store.save(state); }
      }));
      // A failed write is reported to the owner, but must not leave future
      // observations chained forever onto a rejected promise.
      const current = chain;
      chain = chain.catch(() => {});
      return current;
    },
    async error(error) {
      await chain;
      await store.locked(async state => {
        if (state.sessions.find(s => s.id === sessionId)?.codex?.threadId !== rootId) return;
        state.observations ||= {};
        state.observations[sessionId] ||= { rootId, nodes: {} };
        state.observations[sessionId].error = error.message;
        await store.save(state);
      });
    },
    flush: () => chain,
  };
}

export async function validateBinding(adapter, state, session, { threadId, socketPath, executable, codexHome } = {}) {
  if (!threadId) throw new Error('Specify --thread ID or run bind inside Codex with CODEX_THREAD_ID set.');
  const binding = { threadId, socketPath: resolve(socketPath || defaultCodexSocket()),
    executable: executable || process.env.DAG_CODEX_BIN || 'codex',
    codexHome: codexHome || process.env.CODEX_HOME || undefined };
  if (state.sessions.some(s => s.id !== session.id && s.codex?.threadId === threadId && s.codex?.socketPath === binding.socketPath)) {
    throw new Error('This Codex thread is already bound to another DAG session.');
  }
  const thread = await adapter.read(binding);
  const { realpath } = await import('node:fs/promises');
  if (await realpath(thread.cwd) !== await realpath(session.cwd)) throw new Error('Codex thread cwd does not match the DAG session.');
  return { binding, thread };
}
