import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../cli/codex-rpc.mjs';

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const log = item => appendFileSync(process.env.DAG_TEST_LOG, JSON.stringify(item) + '\n');
const socket = value('--listen')?.replace('unix://', '') || value('--remote')?.replace('unix://', '');

if (args[0] === 'app-server') {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const threads = new Map();
  const root = randomUUID();
  let count = 0;
  const notify = (method, params) => {
    for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify({ method, params }));
  };
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.id === undefined) return;
    const p = m.params || {};
    let result = {};
    if (m.method === 'thread/start') {
      const thread = { id: root, cwd: p.cwd, createdAt: Math.floor(Date.now() / 1000), model: 'codex-test-model', status: { type: 'idle' }, materialized: false };
      threads.set(root, thread); result = { thread };
    } else if (m.method === 'thread/inject_items') {
      threads.get(p.threadId).materialized = true;
      log({ type: 'bootstrap', threadId: p.threadId });
    } else if (m.method === 'thread/read' || m.method === 'thread/resume') {
      if (!threads.has(p.threadId)) {
        ws.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'unknown thread' } })); return;
      }
      if (m.method === 'thread/resume' && threads.get(p.threadId).materialized === false) {
        ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: 'no rollout found' } })); return;
      }
      result = { thread: threads.get(p.threadId) };
    } else if (m.method === 'test/queue') {
      const turnId = `turn-${++count}`;
      log({ type: 'queue', thread: p.threadId, text: p.text });
      notify('turn/started', { threadId: root, turn: { id: turnId } });
      notify('item/started', { threadId: root, item: { id: turnId, type: 'commandExecution' } });
      notify('thread/tokenUsage/updated', { threadId: root, tokenUsage: { total: {
        inputTokens: count * 150, outputTokens: count * 20, cachedInputTokens: count * 100, reasoningOutputTokens: count * 7,
      } } });
      notify('item/completed', { threadId: root, item: { id: turnId, type: 'commandExecution' } });
      notify('item/completed', { threadId: root, item: { id: turnId, type: 'commandExecution' } });
      notify('turn/completed', { threadId: root, turn: { id: turnId, status: 'completed' } });
      const child = `${root}-child`;
      if (!threads.has(child)) {
        threads.set(child, { id: child, parentThreadId: root, cwd: process.cwd(),
          createdAt: Math.floor(Date.now() / 1000), agentNickname: 'Review helper', model: 'child-model', status: { type: 'active', activeFlags: [] } });
        notify('item/started', { threadId: root, item: { id: 'spawn-child', type: 'subAgentActivity', agentThreadId: child } });
        setTimeout(() => {
          notify('turn/started', { threadId: child, turn: { id: 'child-turn' } });
          notify('turn/completed', { threadId: child, turn: { id: 'child-turn', status: 'completed' } });
        }, 150);
      }
      result = { queued: true };
    }
    ws.send(JSON.stringify({ id: m.id, result }));
  }));
  http.listen(socket, () => log({ type: 'server', socket, pid: process.pid, codexHome: process.env.CODEX_HOME }));
  process.on('SIGTERM', () => { log({ type: 'server-stop' }); process.exit(0); });
} else if (args[0] === 'queue') {
  const rpc = await new CodexRpc(socket).connect();
  await rpc.request('test/queue', { threadId: value('--thread'), text: value('--message') });
  rpc.close();
} else {
  const threadId = args[args.indexOf('resume') + 1];
  const rpc = await new CodexRpc(socket).connect();
  await rpc.request('thread/resume', { threadId, excludeTurns: true });
  log({ type: 'tui', threadId, args, sessionId: process.env.DAG_SESSION_ID, inheritedThread: process.env.CODEX_THREAD_ID });
  process.on('SIGTERM', () => { rpc.close(); process.exit(0); });
}
