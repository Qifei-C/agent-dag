import { spawn } from 'node:child_process';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
import { CodexRpc } from './codex-rpc.mjs';
import { observationSink } from './codex.mjs';

const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval',
  '--enable', '--disable', '--add-dir', '--local-provider', '-i', '--image']);
const BOOL_FLAGS = new Set(['--search', '--no-alt-screen', '--strict-config', '--oss', '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']);

export function parseCodexLaunch(command) {
  const options = [], serverOptions = [];
  let prompt;
  const args = command.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = arg.split('=')[0];
    if (VALUE_FLAGS.has(key)) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (value === undefined) throw new Error(`Missing value for Codex ${key}.`);
      options.push(key, value);
      if (key === '-c' || key === '--config') serverOptions.push('-c', value);
      if (key === '--enable' || key === '--disable') serverOptions.push('-c', `features.${value}=${key === '--enable'}`);
    } else if (BOOL_FLAGS.has(arg)) options.push(arg);
    else if (!arg.startsWith('-') && prompt === undefined && !['exec', 'resume', 'fork', 'review'].includes(arg)) prompt = arg;
    else throw new Error(`Unsupported managed Codex argument: ${arg}. Use --cwd for the directory; use --adapter tmux for raw Codex commands, profiles, or worktrees.`);
  }
  return { executable: command[0], options, serverOptions, prompt };
}

export async function runCodex(command) {
  const launch = parseCodexLaunch(command);
  const store = new Store();
  const service = new Service({ store });
  const sessionId = process.env.DAG_SESSION_ID;
  const state = await store.snapshot(); // Wait for create's registration transaction.
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Managed Codex launch needs a registered DAG_SESSION_ID.');
  const runtime = await mkdtemp('/tmp/agent-dag-codex-');
  const socketPath = join(runtime, 'server.sock');
  const logPath = join(store.home, `codex-${session.id}.log`);
  const log = await open(logPath, 'a', 0o600);
  let server, tui, rpc, sink, stopped = false, timer;
  const children = new Set();
  let eventWork = Promise.resolve();
  const subscribeChildren = async event => {
    const item = event.params?.item;
    const parent = event.params?.threadId;
    if (!item || !children.has(parent)) return;
    const ids = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' ? item.receiverThreadIds
      : item.type === 'subAgentActivity' ? [item.agentThreadId] : [];
    for (const id of ids || []) {
      if (children.has(id)) continue;
      children.add(id);
      const result = await rpc.request('thread/resume', { threadId: id, excludeTurns: true });
      await sink.push({ method: 'thread/started', params: { thread: { ...result.thread, parentThreadId: parent } } });
    }
  };
  const end = () => { stopped = true; tui?.kill('SIGTERM'); };
  const interrupt = () => {}; // The foreground native TUI receives terminal Ctrl-C itself.
  process.on('SIGTERM', end); process.on('SIGHUP', end); process.on('SIGINT', interrupt);
  try {
    server = spawn(launch.executable, ['app-server', '--listen', `unix://${socketPath}`, ...launch.serverOptions], {
      cwd: session.cwd, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    let serverError;
    server.on('error', error => { serverError = error; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !stopped) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode) throw new Error(`Codex App Server exited; see ${logPath}.`);
      try { rpc = await new CodexRpc(socketPath, { timeout: 1000 }).connect(); break; }
      catch { await delay(100); }
    }
    if (!rpc || stopped) throw new Error('Codex App Server did not become ready.');
    rpc.timeout = 10000;
    const { thread } = await rpc.request('thread/start', { cwd: session.cwd });
    // A just-created thread has no persisted rollout yet; native TUI resume
    // cannot bootstrap it until history is materialized. Appending coordination
    // context persists it without starting a model turn or replacing user config.
    await rpc.request('thread/inject_items', { threadId: thread.id, items: [{
      type: 'message', role: 'developer', content: [{ type: 'input_text',
        text: `This is agent-dag session ${session.name} (${session.id}). `
          + `Coordination guide: ${fileURLToPath(new URL('../skills/session-coordination/SKILL.md', import.meta.url))}. `
          + `Use dag with --home ${JSON.stringify(store.home)}. Messages include IDs; acknowledge receipt with dag ack ID --session ${session.name}. `
          + 'Acknowledgement confirms receipt, not task completion. Existing user permissions and approvals still apply.',
      }],
    }] });
    await service.bindCodex(session.name, { threadId: thread.id, socketPath, executable: launch.executable, managed: true });
    sink = observationSink(store, session.id, thread.id);
    children.add(thread.id);
    rpc.on('notification', event => {
      eventWork = eventWork.then(async () => { await sink.push(event); await subscribeChildren(event); })
        .catch(error => sink.error(error).catch(() => {}));
    });
    rpc.on('disconnect', () => { if (!stopped) void sink.error(new Error('Codex event stream disconnected.')).catch(() => {}); });
    const prompt = launch.prompt ? `Session coordination guide: ${fileURLToPath(new URL('../skills/session-coordination/SKILL.md', import.meta.url))}\n\nTask: ${launch.prompt}` : undefined;
    tui = spawn(launch.executable, ['--remote', `unix://${socketPath}`, ...launch.options,
      'resume', thread.id, ...(prompt ? [prompt] : [])], { cwd: session.cwd, stdio: 'inherit' });
    // Flush messages queued during startup. Native Codex controls when queued
    // turns run; no terminal-input readiness detection is needed.
    let flushing = false, nextMetadataRead = 0;
    timer = setInterval(() => {
      if (flushing || stopped) return;
      flushing = true;
      (async () => {
        await service.flush(session.name);
        if (Date.now() >= nextMetadataRead) {
          const result = await rpc.request('thread/read', { threadId: thread.id });
          await sink.push({ method: 'thread/started', params: { thread: result.thread } });
          nextMetadataRead = Date.now() + 5000;
        }
      })().catch(error => sink.error(error).catch(() => {})).finally(() => { flushing = false; });
    }, 1000);
    const code = await new Promise((resolve, reject) => {
      tui.once('error', reject);
      tui.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
      server.once('exit', () => { if (!stopped) tui.kill('SIGTERM'); });
    });
    return code;
  } finally {
    stopped = true;
    clearInterval(timer);
    rpc?.close();
    await eventWork;
    await sink?.flush();
    tui?.kill('SIGTERM');
    if (server?.pid) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]);
      try { process.kill(-server.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await log.close();
    await rm(runtime, { recursive: true, force: true });
    process.off('SIGTERM', end); process.off('SIGHUP', end); process.off('SIGINT', interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCodex(JSON.parse(process.argv[2])); }
  catch (error) { console.error(`dag codex: ${error.message}`); process.exitCode = 1; }
}
