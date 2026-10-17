import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { applyCodexEvent } from '../cli/codex-events.mjs';
import { CodexRpc } from '../cli/codex-rpc.mjs';
import { CodexAdapter, validateBinding } from '../cli/codex.mjs';
import { parseCodexLaunch } from '../cli/codex-launch.mjs';
import { Service } from '../cli/service.mjs';
import { Store } from '../cli/store.mjs';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/dag', import.meta.url));
const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const env = { ...process.env };
for (const key of ['DAG_HOME', 'DAG_SESSION_ID', 'DAG_TMUX_SOCKET', 'DAG_CODEX_SOCKET', 'CODEX_THREAD_ID', 'TMUX', 'TMUX_PANE']) delete env[key];

async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(40); }
  assert.fail('Timed out waiting for the managed Codex adapter.');
}

async function entries(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t) {
  const dir = await mkdtemp('/tmp/dag-codex-test-');
  const socket = join(dir, 'tmux.sock');
  const home = join(dir, 'state');
  const log = join(dir, 'codex.jsonl');
  const executable = join(dir, 'codex');
  await writeFile(executable, `#!/usr/bin/env node\nprocess.env.DAG_TEST_LOG = ${JSON.stringify(log)};\nawait import(${JSON.stringify(fake)});\n`, { mode: 0o755 });
  const tmux = (...args) => {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return result.stdout.trim();
  };
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'anchor', '/bin/cat');
  t.after(async () => {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    await delay(300);
    await rm(dir, { recursive: true, force: true });
  });
  const cliEnv = { ...env, DAG_HOME: home, DAG_TMUX_SOCKET: socket };
  cliEnv.CODEX_HOME = join(dir, 'custom-codex-home');
  await mkdir(cliEnv.CODEX_HOME);
  const cli = async (...args) => JSON.parse((await execute(process.execPath, [bin, ...args, '--json'], { env: cliEnv })).stdout);
  const store = new Store(home);
  const create = async () => {
    const result = await execute(process.execPath, [bin, 'create', 'coder', '--json', '--role', 'review', '--', executable, '-m', 'chosen-model'], { env: cliEnv });
    const created = JSON.parse(result.stdout);
    try { await eventually(async () => (await entries(log)).some(x => x.type === 'tui')); }
    catch (error) {
      const diagnostic = await readFile(join(home, `codex-${created.id}.log`), 'utf8').catch(() => '');
      throw new Error(error.message + '\n' + diagnostic + '\n' + tmux('capture-pane', '-p', '-t', created.pane));
    }
    return (await store.snapshot()).sessions.find(s => s.id === created.id);
  };
  return { dir, socket, home, log, executable, tmux, cli, store, create, cliEnv };
}

test('managed Codex: automatic binding, native messages, telemetry, subagents, pause and cleanup', async t => {
  const f = await fixture(t);
  const session = await f.create();
  assert.equal(session.adapter, 'codex');
  assert.equal(session.codex.managed, true);
  assert.equal(session.codex.executable, f.executable);
  const tui = (await entries(f.log)).find(x => x.type === 'tui');
  assert.equal(tui.threadId, session.codex.threadId);
  assert.equal(tui.sessionId, session.id);
  assert.equal(tui.inheritedThread, undefined);
  assert.equal((await entries(f.log)).find(x => x.type === 'server').codexHome, f.cliEnv.CODEX_HOME);
  assert.ok(tui.args.includes('chosen-model'));

  const payload = '中文 review\n$(touch /tmp/dag-never-evaluate) C-c; "quoted" \x1b[2J';
  const msg = await f.cli('send', 'coder', payload, '--key', 'first');
  assert.equal(msg.status, 'submitted');
  assert.equal(msg.transport, 'codex');
  assert.equal((await f.cli('send', 'coder', payload, '--key', 'first')).id, msg.id);
  const queued = (await entries(f.log)).filter(x => x.type === 'queue');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].thread, session.codex.threadId);
  assert.ok(queued[0].text.includes(JSON.stringify(payload)));
  assert.ok(!f.tmux('capture-pane', '-p', '-t', session.pane).includes('never-evaluate'));
  await eventually(async () => {
    const obs = (await f.store.snapshot()).observations[session.id];
    return Object.values(obs.nodes).some(n => n.id !== session.codex.threadId && n.status === 'completed');
  });
  const obs = (await f.store.snapshot()).observations[session.id];
  const root = obs.nodes[session.codex.threadId];
  assert.equal(root.inputTokens, 150, 'cache reads are not counted twice');
  assert.equal(root.outputTokens, 20);
  assert.equal(root.toolCount, 1, 'duplicate item/completed notifications do not double count');
  assert.equal(root.turns, 1);
  assert.equal(root.status, 'idle');
  const graph = await f.cli('view', '--once');
  assert.equal(graph.nodes[session.id].inputTokens, 150);
  assert.equal(graph.nodes[`${session.id}:${session.codex.threadId}-child`].parentId, session.id);
  const printed = (await execute(process.execPath, [bin, 'view', '--once'], { env: f.cliEnv })).stdout;
  assert.match(printed, /coder \(review\)/);
  assert.match(printed, /Review helper/);
  assert.match(printed, /tokens 170/);
  assert.equal(printed.includes('\x1b'), false);

  await f.cli('busy', 'coder');
  const rebound = await f.cli('bind', 'coder', '--thread', session.codex.threadId);
  assert.equal(rebound.codex.managed, true);
  assert.equal(rebound.codex.executable, f.executable);
  assert.equal(rebound.status, 'busy');
  assert.equal((await f.cli('send', 'coder', 'paused')).status, 'queued');
  assert.equal((await entries(f.log)).filter(x => x.type === 'queue').length, 1);
  await f.cli('ready', 'coder');
  assert.equal((await entries(f.log)).filter(x => x.type === 'queue').length, 2);
  assert.equal((await f.cli('ack', msg.id, '--session', 'coder')).status, 'acknowledged');
  f.tmux('kill-session', '-t', session.tmuxSession);
  await eventually(async () => (await entries(f.log)).some(x => x.type === 'server-stop'));
  await eventually(async () => { try { await stat(session.codex.socketPath); return false; } catch { return true; } });
  assert.equal((await f.cli('sessions'))[0].status, 'offline');
});

test('standalone dashboard opens in a separate tmux pane and handles density and quit keys', async t => {
  const f = await fixture(t);
  const session = await f.create();
  const output = await execute(process.execPath, [bin, 'view', '--pane', '--json'], {
    env: { ...f.cliEnv, TMUX: `${f.socket},0,0`, TMUX_PANE: session.pane },
  });
  const pane = JSON.parse(output.stdout).pane;
  assert.notEqual(pane, session.pane);
  await eventually(async () => /coder \(review\)/.test(f.tmux('capture-pane', '-p', '-t', pane)));
  f.tmux('send-keys', '-t', pane, 'v');
  await eventually(async () => /v detailed/.test(f.tmux('capture-pane', '-p', '-t', pane)));
  f.tmux('send-keys', '-t', pane, 'q');
  await eventually(async () => !f.tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(pane));
  assert.equal((await f.cli('sessions'))[0].online, true);
  assert.equal((await f.cli('sessions')).length, 1);
});

test('bind rejects wrong IDs and aliases and raw tmux creation remains available', async t => {
  const f = await fixture(t);
  const session = await f.create();
  const pane = f.tmux('display-message', '-p', '-t', 'anchor', '#{pane_id}');
  await f.cli('register', 'other', '--target', pane);
  await assert.rejects(execute(process.execPath, [bin, 'bind', 'other', '--json'], {
    env: { ...f.cliEnv, CODEX_THREAD_ID: session.codex.threadId },
  }), /Cannot infer a thread for another pane/);
  await assert.rejects(f.cli('bind', 'other', '--thread', 'wrong-thread', '--codex-socket', session.codex.socketPath), /unknown thread/);
  await assert.rejects(f.cli('bind', 'other', '--thread', session.codex.threadId, '--codex-socket', session.codex.socketPath), /already bound/);
  assert.equal((await f.cli('sessions')).find(s => s.name === 'other').codex, undefined);
  await assert.rejects(f.cli('create', 'invalid', '--adapter', 'other'), /Adapter must/);
});

test('managed launch preserves native options and rejects ambiguous commands before creating a pane', () => {
  const launch = parseCodexLaunch(['codex', '-c', 'model="custom"', '--sandbox=workspace-write', '-m', 'chosen', 'review this']);
  assert.equal(launch.prompt, 'review this');
  assert.deepEqual(launch.serverOptions, ['-c', 'model="custom"']);
  assert.deepEqual(launch.options, ['-c', 'model="custom"', '--sandbox', 'workspace-write', '-m', 'chosen']);
  assert.throws(() => parseCodexLaunch(['codex', '--remote', 'unix://other']), /Unsupported/);
  assert.throws(() => parseCodexLaunch(['codex', 'exec', 'task']), /Unsupported/);
  assert.throws(() => parseCodexLaunch(['codex', '--model']), /Missing value/);
});

test('Codex usage snapshots, concurrent same-name tools, status and event scoping', () => {
  let state = applyCodexEvent(undefined, 'root', { method: 'thread/started', params: {
    thread: { id: 'root', model: 'codex', status: { type: 'idle' } },
  } }, 1);
  const event = (method, params) => { state = applyCodexEvent(state, 'root', { method, params: { threadId: 'root', ...params } }, 2); };
  event('turn/started', { turn: { id: 't' } }); event('turn/started', { turn: { id: 't' } });
  for (const id of ['a', 'b']) event('item/started', { item: { id, type: 'commandExecution' } });
  event('item/completed', { item: { id: 'a', type: 'commandExecution' } });
  assert.equal(state.nodes.root.currentTool, 'Bash');
  for (let i = 0; i < 2; i++) event('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 10 } } });
  assert.equal(state.nodes.root.inputTokens, 100);
  assert.equal(state.nodes.root.turns, 1);
  event('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  assert.equal(state.nodes.root.status, 'waiting');
  const before = state;
  assert.equal(applyCodexEvent(state, 'root', { method: 'turn/started', params: { threadId: 'unrelated', turn: { id: 'x' } } }), before);
  assert.equal(applyCodexEvent(state, 'root', { method: 'thread/started', params: { thread: { id: 'unrelated' } } }), before);
});

test('native submission failure is durable and never falls back to terminal input', async t => {
  const home = await mkdtemp('/tmp/dag-native-state-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(home);
  await store.locked(async state => {
    state.sessions.push({ id: 's', name: 'receiver', adapter: 'codex', codex: { threadId: 't' }, status: 'ready' });
    await store.save(state);
  });
  let calls = 0;
  const service = new Service({ store, tmux: { inspect: () => ({ online: true }), inject: () => assert.fail('no terminal fallback') },
    codex: { submit: async () => { calls++; throw new Error('lost acknowledgement'); } } });
  const first = await service.send('receiver', 'request', { key: 'one' });
  assert.equal(first.status, 'uncertain');
  assert.equal((await service.send('receiver', 'request', { key: 'one' })).id, first.id);
  await service.flush('receiver');
  assert.equal(calls, 1);
  await assert.rejects(service.readiness('ready', 'receiver'), /unconfirmed/);
});

test('binding checks working directory and submission rejects a mismatched thread response', async t => {
  const dir = await mkdtemp('/tmp/dag-binding-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'other'));
  await assert.rejects(validateBinding({ read: async () => ({ id: 't', cwd: join(dir, 'other') }) },
    { sessions: [] }, { id: 's', cwd: dir }, { threadId: 't', socketPath: '/tmp/socket' }), /cwd does not match/);
  let submitted = false;
  const adapter = new CodexAdapter({ rpc: () => ({ connect: async function () { return this; },
    request: async () => ({ thread: { id: 'other' } }), close() {} }), execute: async () => { submitted = true; } });
  await assert.rejects(adapter.submit({ threadId: 'wanted', socketPath: '/tmp/socket' }, 'hello'), /different thread ID/);
  assert.equal(submitted, false);
});

test('RPC observer never approves a server request and times out pending calls', async t => {
  const dir = await mkdtemp('/tmp/dag-rpc-');
  const http = createServer(); const wss = new WebSocketServer({ server: http });
  const received = [];
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(data); received.push(m);
    if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
    if (m.method === 'initialized') ws.send(JSON.stringify({ id: 999, method: 'item/commandExecution/requestApproval', params: {} }));
  }));
  await new Promise(resolve => http.listen(join(dir, 'rpc.sock'), resolve));
  const rpc = await new CodexRpc(join(dir, 'rpc.sock'), { timeout: 60 }).connect();
  t.after(async () => { rpc.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(rpc.request('unanswered'), /timed out/);
  assert.equal(received.some(m => m.id === 999), false);
});
