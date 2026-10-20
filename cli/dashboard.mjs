import { emitKeypressEvents } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Tmux } from './tmux.mjs';
import { CodexRpc } from './codex-rpc.mjs';
import { observationSink } from './codex.mjs';
import { availabilityOf } from './availability.mjs';

async function layout() {
  try { return await import('./layout.mjs'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Dashboard renderer is not built. Run npm install and npm run build in the agent-dag checkout.');
  }
}

export async function dashboardState(service) {
  const l = await layout();
  const snapshot = await service.store.snapshot();
  const state = l.freshState(Date.now(), 'cards');
  const online = new Map((await service.sessions()).map(s => [s.id, s.online]));
  for (const session of snapshot.sessions) {
    const observation = snapshot.observations?.[session.id];
    const root = observation?.nodes?.[session.codex?.threadId];
    const isOnline = online.get(session.id);
    const stale = !!observation?.error;
    const availability = availabilityOf(session);
    const pending = snapshot.messages.filter(m => m.to === session.id && m.status === 'queued').length;
    const hold = availability.state !== 'available';
    const node = {
      ...state.nodes.main, ...root, id: session.id,
      parentId: snapshot.sessions.some(s => s.id === session.parentId) ? session.parentId : 'main',
      label: `${session.name}${session.role ? ` (${session.role})` : ''}${hold ? ` [${availability.state}; queued ${pending}]` : ''}${!isOnline ? ' [offline]' : stale ? ' [telemetry unavailable]' : ''}`,
      availability, pending,
      deliveryNotice: hold ? `${availability.state}: ${availability.reason}${availability.retryAt ? `; expected reset ${availability.retryAt}` : ''}; dag resume ${session.name}` : undefined,
      type: 'session', status: !isOnline || stale ? 'waiting' : root?.status || 'idle',
      startedAt: Date.parse(session.createdAt), currentTool: !isOnline || stale ? undefined : root?.currentTool,
    };
    state.nodes[node.id] = node;
    state.order.push(node.id);
    for (const child of Object.values(observation?.nodes || {})) {
      if (child.id === session.codex?.threadId) continue;
      const id = `${session.id}:${child.id}`;
      state.nodes[id] = { ...child, id, isTeammate: false,
        parentId: child.parentId === session.codex.threadId ? session.id : `${session.id}:${child.parentId}`,
        status: (!isOnline || stale) && ['running', 'pending', 'waiting'].includes(child.status) ? 'waiting' : child.status,
        currentTool: !isOnline || stale ? undefined : child.currentTool };
      state.order.push(id);
    }
  }
  const edges = new Map();
  for (const message of snapshot.messages) {
    const key = `${message.from}:${message.to}`;
    const previous = edges.get(key);
    edges.set(key, { from: message.from, to: message.to, count: (previous?.count || 0) + 1,
      lastAt: Date.parse(message.createdAt), lastText: message.text.replace(/\s+/g, ' ').slice(0, 60) });
  }
  state.messages = [...edges.values()];
  return state;
}

async function observeExternal(service, observers) {
  const { sessions } = await service.store.snapshot();
  for (const [id, rpc] of observers) {
    if (!sessions.some(s => s.id === id)) {
      observers.delete(id);
      rpc?.close();
    }
  }
  for (const session of sessions) {
    if (!session.codex || session.codex.managed || observers.has(session.id)) continue;
    if (!service.tmux.inspect(session).online) continue;
    observers.set(session.id, null);
    const sink = observationSink(service.store, session.id, session.codex.threadId);
    let rpc;
    try {
      rpc = await new CodexRpc(session.codex.socketPath).connect();
      rpc.on('notification', event => { void sink.push(event).catch(() => {}); });
      const result = await rpc.request('thread/resume', { threadId: session.codex.threadId, excludeTurns: true });
      await sink.push({ method: 'thread/started', params: { thread: result.thread } });
      rpc.on('disconnect', () => { observers.delete(session.id); void sink.error(new Error('Codex event stream disconnected.')).catch(() => {}); });
      observers.set(session.id, rpc);
    } catch (error) {
      rpc?.close(); observers.delete(session.id);
      await sink.error(error);
    }
  }
}

export function openDashboardPane(service, options) {
  if (!process.env.TMUX_PANE) throw new Error('Run dag view --pane inside tmux, or use dag view in a terminal.');
  const tmux = new Tmux(Tmux.callerSocket());
  const width = Number(tmux.run(['display-message', '-p', '-t', process.env.TMUX_PANE, '#{window_width}']));
  const pane = tmux.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', process.env.TMUX_PANE,
    ...(width >= 120 ? ['-h', '-l', '72'] : ['-v', '-l', '60%']),
    'env', '-u', 'DAG_SESSION_ID', '-u', 'CODEX_THREAD_ID', `DAG_HOME=${service.store.home}`,
    process.execPath, fileURLToPath(new URL('../bin/dag', import.meta.url)), 'view',
    ...(options.compact ? ['--compact'] : []), ...(options.ascii ? ['--ascii'] : [])]);
  return pane;
}

export async function runDashboard(service, options = {}) {
  const l = await layout();
  if (!options.once && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive view needs a terminal; use --once to print a snapshot.');
  let compact = !!options.compact, messages = true, tools = true, offset = 0, quit = false;
  const observers = new Map();
  const onKey = (_, key = {}) => {
    if (key.name === 'q' || key.name === 'c' && key.ctrl) quit = true;
    if (key.name === 'v') compact = !compact;
    if (key.name === 'm') messages = !messages;
    if (key.name === 't') tools = !tools;
    if (key.name === 'up' || key.name === 'k') offset = Math.max(0, offset - 1);
    if (key.name === 'down' || key.name === 'j') offset++;
    if (key.name === 'pageup') offset = Math.max(0, offset - 10);
    if (key.name === 'pagedown') offset += 10;
    if (key.name === 'home') offset = 0;
  };
  const end = () => { quit = true; };
  const wasRaw = process.stdin.isRaw;
  const color = { claude: 36, success: 32, error: 31, warning: 33, subtle: 90 };
  const safeText = text => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const paint = row => row.map(s => {
    const text = safeText(s.text);
    if (options.once || process.env.NO_COLOR !== undefined) return text;
    const codes = [s.bold ? 1 : undefined, s.dim ? 2 : undefined, color[s.color]].filter(Boolean);
    return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
  }).join('');
  try {
    if (!options.once) {
      emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on('keypress', onKey);
      process.on('SIGTERM', end); process.on('SIGINT', end);
      process.stdout.write('\x1b[?1049h\x1b[?25l');
    }
    let nextObserve = 0;
    do {
      if (!options.once && Date.now() >= nextObserve) {
        await observeExternal(service, observers); nextObserve = Date.now() + 5000;
      }
      const state = await dashboardState(service);
      state.showMessages = messages; state.showTools = tools;
      if (options.json) { console.log(JSON.stringify(state, null, 2)); return; }
      const o = { columns: process.stdout.columns || 80, glyphs: options.ascii ? 'ascii' : 'unicode', now: Date.now() };
      const body = compact || o.columns < 36 ? l.treeRows(state, o).slice(1)
        : l.cardRows(state, o).slice(l.cards(state, o)[0].rows.length + 1);
      const rows = [[{ text: `Sessions: ${state.order.length - 1} agents`, bold: true }], ...body,
        ...l.messageRows(state, o)];
      if (options.once) { console.log(rows.map(paint).join('\n')); return; }
      const height = Math.max(1, (process.stdout.rows || 24) - 1);
      offset = Math.max(0, Math.min(offset, rows.length - height));
      const footer = l.fit(`q quit  v ${compact ? 'detailed' : 'compact'}  m messages  t tools  arrows scroll`, o.columns).trimEnd();
      process.stdout.write('\x1b[H\x1b[2J' + rows.slice(offset, offset + height).map(paint).join('\n')
        + `\n\x1b[2m${footer}\x1b[0m`);
      await delay(250);
    } while (!quit);
  } finally {
    for (const rpc of observers.values()) rpc?.close();
    if (!options.once) {
      process.stdin.off('keypress', onKey); process.stdin.setRawMode(wasRaw || false); process.stdin.pause();
      process.off('SIGTERM', end); process.off('SIGINT', end);
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
  }
}
