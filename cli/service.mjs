import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { resolve, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Tmux } from './tmux.mjs';
import { CodexAdapter, validateBinding } from './codex.mjs';
import { applyCodexEvent } from './codex-events.mjs';

const BIN = fileURLToPath(new URL('../bin/', import.meta.url));
const now = () => new Date().toISOString();
const validName = name => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name || '')) {
    throw new Error('Name must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.');
  }
};

export function findSession(state, ref) {
  const session = state.sessions.find(s => s.id === ref || s.name === ref);
  if (!session) throw new Error(`Unknown session: ${ref || '(none)'}`);
  return session;
}

export class Service {
  constructor({ store = new Store(), tmux = new Tmux(), codex = new CodexAdapter() } = {}) {
    this.store = store;
    this.tmux = tmux;
    this.codex = codex;
  }

  current(state, explicit, optional = false) {
    if (explicit) return findSession(state, explicit);
    if (process.env.DAG_SESSION_ID) return findSession(state, process.env.DAG_SESSION_ID);
    if (process.env.TMUX_PANE) {
      try {
        const pane = new Tmux(Tmux.callerSocket()).pane(process.env.TMUX_PANE);
        const session = state.sessions.find(s => s.id === pane['@dag_session_id'] && s.socket === pane.socket_path);
        if (session) return session;
      } catch { /* no registered current pane */ }
    }
    if (optional) return undefined;
    throw new Error('No current session. Specify its name (or --session NAME for ack), or register the current tmux pane.');
  }

  parent(state, ref) {
    return ref === 'none' ? undefined : this.current(state, ref, true)?.id;
  }

  async create(name, { cwd = process.cwd(), role = '', parent, command = [], adapter } = {}) {
    validName(name);
    cwd = await realpath(resolve(cwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    return this.store.locked(async state => {
      if (state.sessions.some(s => s.name === name)) throw new Error(`Session name already registered: ${name}`);
      const id = randomUUID();
      const parentId = this.parent(state, parent);
      const launch = command.length ? command : [adapter === 'codex' ? process.env.DAG_CODEX_BIN || 'codex' : process.env.SHELL || '/bin/sh'];
      adapter ||= basename(launch[0]) === 'codex' ? 'codex' : 'tmux';
      if (!['tmux', 'codex'].includes(adapter)) throw new Error('Adapter must be tmux or codex.');
      if (adapter === 'codex') {
        const { parseCodexLaunch } = await import('./codex-launch.mjs');
        parseCodexLaunch(launch); // Validate before starting any tmux process.
      }
      const executable = adapter === 'codex'
        ? [process.execPath, fileURLToPath(new URL('./codex-launch.mjs', import.meta.url)), JSON.stringify(launch)] : launch;
      // env + argv forces tmux's direct-exec path, including a one-word command.
      // Do not inherit a parent's DAG identity into a newly created session.
      const output = this.tmux.run(['new-session', '-d', '-P', '-F', '#{pane_id}',
        '-s', name, '-c', cwd,
        '-e', `DAG_SESSION_ID=${id}`, '-e', `DAG_HOME=${this.store.home}`,
        '-e', `PATH=${BIN}${delimiter}${process.env.PATH || ''}`,
        'env', '-u', 'DAG_TMUX_SOCKET', '-u', 'CLAUDECODE', '-u', 'CODEX_THREAD_ID', '-u', 'CODEX_HOME',
        ...(process.env.CODEX_HOME ? [`CODEX_HOME=${resolve(process.env.CODEX_HOME)}`] : []),
        `DAG_SESSION_ID=${id}`, `DAG_HOME=${this.store.home}`,
        `PATH=${BIN}${delimiter}${process.env.PATH || ''}`, ...executable]);
      const pane = this.tmux.pane(output);
      const tmux = new Tmux(pane.socket_path);
      const session = {
        id, name, role, cwd, parentId, socket: pane.socket_path,
        tmuxSession: pane.session_id, tmuxName: pane.session_name, pane: pane.pane_id,
        command: launch, adapter, status: 'unknown', createdAt: now(), updatedAt: now(),
      };
      // Keep a discoverable record if binding fails; never kill an agent that
      // may already have started useful work merely to roll back registration.
      state.sessions.push(session);
      await this.store.save(state);
      try { tmux.bind(session.pane, id); }
      catch (error) {
        throw new Error(`Created tmux session ${name} but could not bind it: ${error.message}. Run dag register ${name} --target ${session.pane} --socket ${session.socket} to repair.`);
      }
      return session;
    });
  }

  async register(name, { target = process.env.TMUX_PANE, role, parent, replace = false } = {}) {
    validName(name);
    if (!target) throw new Error('Use --target PANE when registering outside tmux.');
    return this.store.locked(async state => {
      const pane = this.tmux.pane(target);
      if (pane.pane_dead !== '0') throw new Error('Cannot register a dead pane.');
      const existing = state.sessions.find(s => s.name === name);
      const binding = state.sessions.find(s => s.pane === pane.pane_id && s.socket === pane.socket_path);
      if (binding && binding !== existing) throw new Error(`Pane already registered as ${binding.name}.`);
      const moved = existing && (existing.pane !== pane.pane_id || existing.socket !== pane.socket_path);
      if (moved && (!replace || this.tmux.inspect(existing).online)) {
        throw new Error(`Session ${name} already points to a different pane. --replace can rebind an offline session.`);
      }
      if (pane['@dag_session_id'] && pane['@dag_session_id'] !== existing?.id) {
        throw new Error('Pane is bound to another DAG registry/session. Use the original DAG_HOME.');
      }
      const session = existing || {
        id: randomUUID(), name, parentId: this.parent(state, parent),
        socket: pane.socket_path, pane: pane.pane_id, tmuxSession: pane.session_id,
        tmuxName: pane.session_name, cwd: pane.pane_current_path,
        command: [], role: '', status: 'unknown', createdAt: now(),
      };
      if (existing && (moved || pane['@dag_session_id'] !== existing.id)) {
        Object.assign(session, { socket: pane.socket_path, pane: pane.pane_id,
          tmuxSession: pane.session_id, tmuxName: pane.session_name,
          cwd: pane.pane_current_path, status: 'unknown' });
        // A new terminal must not inherit the previous process's native thread.
        delete session.codex;
        if (state.observations) delete state.observations[session.id];
      }
      if (session.parentId === session.id) throw new Error('Session cannot be its own parent.');
      if (role !== undefined) session.role = role;
      session.updatedAt = now();
      new Tmux(session.socket).bind(session.pane, session.id);
      if (!existing) state.sessions.push(session);
      await this.store.save(state);
      return session;
    });
  }

  async sessions() {
    const state = await this.store.snapshot();
    return state.sessions.map(s => {
      const live = this.tmux.inspect(s);
      return { ...s, online: live.online, status: live.online ? s.status : 'offline',
        activity: state.observations?.[s.id]?.nodes?.[s.codex?.threadId]?.status,
        model: state.observations?.[s.id]?.nodes?.[s.codex?.threadId]?.model,
        error: live.error,
        pending: state.messages.filter(m => m.to === s.id && m.status === 'queued').length };
    });
  }

  async send(to, text, { from, replyTo, key } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message cannot be empty.');
    if (Buffer.byteLength(text) > 16384) throw new Error('Message exceeds 16 KiB; send an artifact path instead.');
    if (key !== undefined && (!key.trim() || key.length > 128)) throw new Error('--key must be 1–128 characters.');
    return this.store.locked(async state => {
      const receiver = findSession(state, to);
      const sender = this.current(state, from, true);
      if (key !== undefined) {
        const previous = state.messages.find(m => m.from === (sender?.id || 'person') && m.to === receiver.id && m.key === key);
        if (previous) {
          if (previous.text !== text || previous.replyTo !== replyTo) throw new Error('--key was already used for a different message.');
          return previous;
        }
      }
      if (replyTo && !state.messages.some(m => m.id === replyTo && m.to === sender?.id)) {
        throw new Error('--reply-to must identify a message addressed to the sender.');
      }
      const message = {
        id: randomUUID(), from: sender?.id || 'person', fromName: sender?.name || 'person',
        to: receiver.id, toName: receiver.name, text, replyTo, key,
        status: 'queued', createdAt: now(),
      };
      state.messages.push(message);
      await this.store.save(state);
      await this.deliverOne(state, receiver);
      return message;
    });
  }

  async deliverOne(state, session) {
    const native = session.adapter === 'codex';
    if (native ? !session.codex || session.deliveryPaused : session.status !== 'ready') return;
    if (state.messages.some(m => m.to === session.id && ['sending', 'uncertain'].includes(m.status))) return;
    const message = state.messages.find(m => m.to === session.id && m.status === 'queued');
    if (!message || !this.tmux.inspect(session).online) return;
    // Commit before sending. A crash can leave 'sending', which requires
    // acknowledgement rather than blind replay and duplicate terminal input.
    if (!native) session.status = 'busy';
    session.updatedAt = now();
    message.status = 'sending';
    message.attemptedAt = now();
    await this.store.save(state);
    const envelope = `[dag id=${message.id} from=${message.fromName}${message.replyTo ? ` reply-to=${message.replyTo}` : ''}] ${JSON.stringify(message.text)} | acknowledge: dag ack ${message.id}`;
    try {
      if (native) {
        const instructions = `\nDAG session: ${session.name}. Coordination guide: ${fileURLToPath(new URL('../skills/session-coordination/SKILL.md', import.meta.url))}. `
          + `Use dag with --home ${JSON.stringify(this.store.home)}; acknowledge this message with --session ${session.name}.`;
        await this.codex.submit(session.codex, envelope + instructions);
        message.status = 'submitted';
        message.submittedAt = now();
        message.transport = 'codex';
      } else {
        await this.tmux.inject(session, envelope);
        message.status = 'injected';
        message.injectedAt = now();
        message.transport = 'tmux';
      }
    } catch (error) {
      message.status = 'uncertain';
      message.error = error.message;
    }
    await this.store.save(state);
  }

  async readiness(status, ref) {
    return this.store.locked(async state => {
      const session = this.current(state, ref);
      if (!this.tmux.inspect(session).online) throw new Error('Session pane is offline or its binding has changed.');
      if (status === 'ready' && state.messages.some(m => m.to === session.id && ['sending', 'uncertain'].includes(m.status))) {
        throw new Error('An earlier delivery is unconfirmed. Inspect dag inbox and acknowledge it before accepting another.');
      }
      session.status = status;
      if (session.adapter === 'codex') session.deliveryPaused = status === 'busy';
      session.updatedAt = now();
      await this.store.save(state);
      if (status === 'ready') {
        for (;;) {
          const before = state.messages.filter(m => m.to === session.id && m.status === 'queued').length;
          await this.deliverOne(state, session);
          const after = state.messages.filter(m => m.to === session.id && m.status === 'queued').length;
          if (session.adapter !== 'codex' || after === before || after === 0) break;
        }
      }
      return session;
    });
  }

  async inbox(ref, all = false) {
    const state = await this.store.snapshot();
    const session = this.current(state, ref);
    return state.messages.filter(m => m.to === session.id && (all || m.status !== 'acknowledged'));
  }

  async ack(id, ref) {
    return this.store.locked(async state => {
      const session = this.current(state, ref);
      const message = state.messages.find(m => m.id === id && m.to === session.id);
      if (!message) throw new Error('Message not found in this session’s inbox.');
      message.status = 'acknowledged';
      message.acknowledgedAt ||= now();
      // Inbox polling may acknowledge a queued message without injecting it.
      await this.store.save(state);
      return message;
    });
  }

  async attach(ref) {
    const session = findSession(await this.store.snapshot(), ref);
    const live = this.tmux.inspect(session);
    if (!live.online) throw new Error('Session pane is offline or its binding has changed.');
    return { socket: session.socket, session: live.pane.session_id, pane: session.pane };
  }

  async bindCodex(ref, options = {}) {
    return this.store.locked(async state => {
      const session = this.current(state, ref);
      if (options.inferred && this.current(state, undefined, true)?.id !== session.id) {
        throw new Error('Cannot infer a thread for another pane. Run bind inside the receiving session, or specify --thread ID.');
      }
      if (!this.tmux.inspect(session).online) throw new Error('Cannot bind an offline pane.');
      const { binding, thread } = await validateBinding(this.codex, state, session, {
        ...options, socketPath: options.socketPath || session.codex?.socketPath,
        executable: options.executable || session.codex?.executable,
        codexHome: session.codex?.codexHome,
      });
      if (session.codex && (session.codex.threadId !== binding.threadId || session.codex.socketPath !== binding.socketPath)) {
        throw new Error('Session is already bound to a different Codex thread. Re-register its offline pane with --replace first.');
      }
      session.adapter = 'codex'; session.codex = { ...binding, managed: options.managed ?? session.codex?.managed ?? false };
      session.status = session.deliveryPaused ? 'busy' : 'ready'; session.updatedAt = now();
      state.observations ||= {};
      state.observations[session.id] = applyCodexEvent(state.observations[session.id], binding.threadId,
        { method: 'thread/started', params: { thread } });
      await this.store.save(state);
      return session;
    });
  }

  async flush(ref) {
    return this.store.locked(async state => {
      const session = this.current(state, ref);
      while (state.messages.some(m => m.to === session.id && m.status === 'queued')) {
        const before = state.messages.filter(m => m.to === session.id && m.status === 'queued').length;
        await this.deliverOne(state, session);
        if (state.messages.filter(m => m.to === session.id && m.status === 'queued').length === before) break;
      }
      return session;
    });
  }
}
