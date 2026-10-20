import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../cli/store.mjs';
import { Service } from '../cli/service.mjs';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/dag', import.meta.url));
const receiver = fileURLToPath(new URL('./receiver.mjs', import.meta.url));
const cleanEnv = { ...process.env };
for (const key of ['DAG_HOME', 'DAG_SESSION_ID', 'DAG_TMUX_SOCKET', 'TMUX', 'TMUX_PANE']) delete cleanEnv[key];

async function fixture(t) {
  const root = await mkdtemp('/tmp/dag-test-');
  const home = join(root, 'registry');
  const socket = join(root, 'tmux.sock');
  t.after(async () => {
    spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  });
  const start = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'anchor', '/bin/cat'], { encoding: 'utf8' });
  assert.equal(start.status, 0, `isolated tmux server: ${start.stderr}`);
  assert.equal(start.stderr, '', `isolated tmux server: ${start.stderr}`);
  const env = { ...cleanEnv, DAG_HOME: home, DAG_TMUX_SOCKET: socket };
  const cli = async (...args) => {
    const { stdout } = await exec(process.execPath, [bin, ...args, '--json'], { env });
    return JSON.parse(stdout);
  };
  const tmux = (...args) => {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { root, home, socket, cli, tmux, env, create: async (name, ...args) => {
    const log = join(root, `${name}.jsonl`);
    const { stdout } = await exec(process.execPath, [bin, 'create', name, '--json', ...args,
      '--', process.execPath, receiver, log], { env });
    const session = JSON.parse(stdout);
    await eventually(async () => (await lines(log)).length > 0);
    return { session, log };
  } };
}

async function lines(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30); }
  assert.fail('Timed out waiting for terminal process.');
}

test('real tmux: create, register, queue, inject, acknowledge, reply, and offline detection', async t => {
  const f = await fixture(t);
  const a = await f.create('builder', '--role', 'implementation');
  const b = await f.create('reviewer', '--parent', 'builder', '--role', 'review');
  const started = (await lines(b.log))[0];
  assert.equal(started.sessionId, b.session.id);
  assert.equal(started.home, f.home);
  assert.equal(started.self.id, b.session.id, 'child can run dag through inherited PATH and discover itself');
  assert.equal(b.session.parentId, a.session.id);
  assert.equal((await f.cli('sessions')).length, 2);
  await assert.rejects(f.cli('create', 'reviewer'), /already registered/);
  await assert.rejects(f.cli('register', 'alias', '--target', b.session.pane), /already registered/);

  const external = f.tmux('display-message', '-p', '-t', 'anchor', '#{pane_id}');
  const registered = await f.cli('register', 'existing', '--target', external);
  assert.equal(registered.pane, external);
  assert.equal((await f.cli('register', 'existing', '--target', external)).id, registered.id);

  const text = 'review "quoted" diff\n$(touch /tmp/dag-do-not-create) `echo hello`\x1b\rC-c 中文';
  const sent = await f.cli('send', 'reviewer', text, '--from', 'builder');
  assert.equal(sent.status, 'queued');
  assert.equal((await lines(b.log)).length, 1, 'unknown readiness never injects input');
  assert.equal((await f.cli('inbox', 'reviewer'))[0].text, text);
  assert.equal((await f.cli('ready', 'reviewer')).status, 'busy');
  await eventually(async () => (await lines(b.log)).length === 2);
  const injected = (await lines(b.log))[1].line;
  assert.ok(injected.includes(JSON.stringify(text)));
  assert.ok(injected.includes(`id=${sent.id}`));
  assert.equal((await f.cli('messages'))[0].status, 'injected');
  await assert.rejects(f.cli('ack', sent.id, '--session', 'builder'), /not found/);
  assert.equal((await f.cli('ack', sent.id, '--session', 'reviewer')).status, 'acknowledged');
  assert.deepEqual(await f.cli('inbox', 'reviewer'), []);
  assert.equal((await f.cli('inbox', 'reviewer', '--all')).length, 1);
  const reply = await f.cli('send', 'builder', 'review complete', '--from', 'reviewer', '--reply-to', sent.id);
  assert.equal(reply.replyTo, sent.id);
  await assert.rejects(f.cli('send', 'builder', 'bad', '--from', 'builder', '--reply-to', sent.id), /addressed to the sender/);

  // Polling inbox + ack consumes queued messages without terminal injection.
  await f.cli('ack', reply.id, '--session', 'builder');
  await f.cli('ready', 'builder');
  assert.equal((await lines(a.log)).length, 1);
  f.tmux('kill-session', '-t', b.session.tmuxSession);
  const offline = (await f.cli('sessions')).find(s => s.id === b.session.id);
  assert.equal(offline.status, 'offline');
  assert.equal((await f.cli('send', 'reviewer', 'keep until receiver returns')).status, 'queued');
  await assert.rejects(f.cli('ready', 'reviewer'), /offline/);
});

test('concurrent CLI processes preserve all messages and deliver only one per ready', async t => {
  const f = await fixture(t);
  const { log } = await f.create('worker');
  const messages = await Promise.all(Array.from({ length: 10 }, (_, i) => f.cli('send', 'worker', `message ${i}`)));
  assert.equal(new Set(messages.map(m => m.id)).size, 10);
  assert.equal((await f.cli('messages')).length, 10);
  await f.cli('ready', 'worker');
  await eventually(async () => (await lines(log)).length === 2);
  const history = await f.cli('messages');
  assert.equal(history.filter(m => m.status === 'injected').length, 1);
  assert.equal(history.filter(m => m.status === 'queued').length, 9);
  await f.cli('ready', 'worker');
  await eventually(async () => (await lines(log)).length === 3);
  assert.equal((await f.cli('messages')).filter(m => m.status === 'queued').length, 8);
});

test('creation preserves cwd and exact command argv without shell evaluation', async t => {
  const f = await fixture(t);
  const cwd = join(f.root, 'directory with spaces');
  const log = join(f.root, 'argv.jsonl');
  const marker = join(f.root, 'SHOULD_NOT_EXIST');
  await mkdir(cwd);
  const literal = `$(touch '${marker}')`;
  const { stdout } = await exec(process.execPath, [bin, 'create', 'literal', '--cwd', cwd, '--json', '--',
    process.execPath, receiver, log, literal, 'a b', ';', 'a;', '\\;', 'a;;', '"quoted"'], { env: f.env });
  const session = JSON.parse(stdout);
  await eventually(async () => (await lines(log)).length > 0);
  const info = (await lines(log))[0];
  assert.deepEqual(info.args, [literal, 'a b', ';', 'a;', '\\;', 'a;;', '"quoted"']);
  assert.equal(info.cwd, session.cwd);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('changed pane binding prevents injection into a different agent', async t => {
  const f = await fixture(t);
  const { session, log } = await f.create('worker');
  await f.cli('ready', 'worker');
  f.tmux('set-option', '-p', '-t', session.pane, '@dag_session_id', 'different-registry');
  const msg = await f.cli('send', 'worker', 'must remain queued');
  assert.equal(msg.status, 'queued');
  assert.equal((await lines(log)).length, 1);
  assert.equal((await f.cli('sessions'))[0].status, 'offline');
});

test('idempotent sends survive concurrent retries and reject changed payloads', async t => {
  const f = await fixture(t);
  await f.create('worker');
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    f.cli('send', 'worker', 'one request', '--key', 'request-42')));
  assert.equal(new Set(results.map(m => m.id)).size, 1);
  assert.equal((await f.cli('messages')).length, 1);
  await assert.rejects(f.cli('send', 'worker', 'different request', '--key', 'request-42'), /different message/);
});

test('offline session can rebind with the same identity and pending inbox', async t => {
  const f = await fixture(t);
  const { session } = await f.create('worker');
  const message = await f.cli('send', 'worker', 'pending task');
  const replacement = f.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'replacement', '/bin/cat');
  await assert.rejects(f.cli('register', 'worker', '--target', replacement, '--replace'), /different pane/);
  f.tmux('kill-session', '-t', session.tmuxSession);
  await assert.rejects(f.cli('register', 'worker', '--target', replacement), /--replace/);
  const rebound = await f.cli('register', 'worker', '--target', replacement, '--replace');
  assert.equal(rebound.id, session.id);
  assert.equal(rebound.pane, replacement);
  assert.equal(rebound.status, 'unknown');
  assert.equal((await f.cli('inbox', 'worker'))[0].id, message.id);
});

test('unregister releases identity and pane, preserves history, and makes children roots', async t => {
  const f = await fixture(t);
  const { session } = await f.create('parent');
  const { session: child } = await f.create('child', '--parent', 'parent');
  const message = await f.cli('send', 'parent', 'retained history', '--from', 'child');
  const store = new Store(f.home);
  await store.locked(async state => {
    state.observations = { [session.id]: { nodes: {} }, [child.id]: { nodes: {} } };
    await store.save(state);
  });
  const removed = await f.cli('unregister', session.id, '--socket', join(f.root, 'unused.sock'));
  assert.equal(removed[0].id, session.id);
  assert.equal(f.tmux('display-message', '-p', '-t', session.pane, '#{pane_dead}'), '0');
  assert.equal(f.tmux('show-options', '-p', '-t', session.pane).includes('@dag_session_id'), false);
  const state = await store.snapshot();
  assert.deepEqual(state.sessions.map(s => s.id), [child.id]);
  assert.equal(state.sessions[0].parentId, undefined);
  assert.equal(state.observations[session.id], undefined);
  assert.ok(state.observations[child.id]);
  assert.equal((await f.cli('messages'))[0].id, message.id);
  await assert.rejects(f.cli('send', 'parent', 'no receiver'), /Unknown session/);
  const replacement = await f.cli('register', 'parent', '--target', session.pane);
  assert.notEqual(replacement.id, session.id);
  assert.deepEqual(await f.cli('inbox', 'parent'), [], 'old messages never move to a reused name');
});

test('unregister infers the current session and tolerates a stale inherited identity afterward', async t => {
  const f = await fixture(t);
  const { session, log } = await f.create('worker');
  const startup = (await lines(log))[0];
  const currentEnv = { ...f.env, DAG_SESSION_ID: session.id, TMUX: startup.tmux, TMUX_PANE: session.pane };
  const removed = await exec(process.execPath, [bin, 'unregister', '--json'], { env: currentEnv });
  assert.equal(JSON.parse(removed.stdout)[0].id, session.id);
  await assert.rejects(f.cli('unregister', 'worker'), /Unknown session/);
  await assert.rejects(f.cli('unregister'), /No current session/);
  await assert.rejects(f.cli('unregister', 'worker', '--offline'), /not both/);
  const registered = JSON.parse((await exec(process.execPath,
    [bin, 'register', 'worker', '--json'], { env: currentEnv })).stdout);
  const sent = JSON.parse((await exec(process.execPath,
    [bin, 'send', 'worker', 'new identity', '--json'], { env: currentEnv })).stdout);
  assert.equal(sent.from, registered.id, 'pane binding supersedes the unregistered environment ID');
});

test('unregister --offline removes closed, dead and rebound panes while leaving live sessions alone', async t => {
  const f = await fixture(t);
  const { session: live } = await f.create('live');
  const { session: closed } = await f.create('closed');
  const { session: dead } = await f.create('dead');
  const { session: foreign } = await f.create('foreign');
  f.tmux('kill-session', '-t', closed.tmuxSession);
  f.tmux('set-option', '-p', '-t', dead.pane, 'remain-on-exit', 'on');
  f.tmux('respawn-pane', '-k', '-t', dead.pane, '/usr/bin/true');
  await eventually(async () => f.tmux('display-message', '-p', '-t', dead.pane, '#{pane_dead}') === '1');
  f.tmux('set-option', '-p', '-t', foreign.pane, '@dag_session_id', 'another-registry');
  const removed = await f.cli('unregister', '--offline');
  assert.deepEqual(new Set(removed.map(s => s.id)), new Set([closed.id, dead.id, foreign.id]));
  assert.deepEqual((await f.cli('sessions')).map(s => s.id), [live.id]);
  assert.equal(f.tmux('show-options', '-p', '-t', dead.pane).includes('@dag_session_id'), false);
  assert.equal(f.tmux('display-message', '-p', '-t', foreign.pane, '#{@dag_session_id}'), 'another-registry');
  assert.deepEqual(await f.cli('unregister', '--offline'), []);
  const text = (await exec(process.execPath, [bin, 'unregister', 'live'], { env: f.env })).stdout;
  assert.match(text, /Unregistered live/);
  assert.deepEqual(await f.cli('sessions'), []);
});

test('created child infers its parent and commands infer sender identity', async t => {
  const f = await fixture(t);
  const { session } = await f.create('parent');
  const log = join(f.root, 'child.jsonl');
  const { stdout } = await exec(process.execPath, [bin, 'create', 'child', '--json', '--',
    process.execPath, receiver, log], { env: { ...f.env, DAG_SESSION_ID: session.id } });
  const child = JSON.parse(stdout);
  assert.equal(child.parentId, session.id);
  await eventually(async () => (await lines(log)).length > 0);
  const sent = await exec(process.execPath, [bin, 'send', 'parent', 'child result', '--json'],
    { env: { ...f.env, DAG_SESSION_ID: child.id } });
  assert.equal(JSON.parse(sent.stdout).from, child.id);
  const startup = (await lines(log))[0];
  const inferred = await exec(process.execPath, [bin, 'send', 'parent', 'inferred from tmux pane', '--json'],
    { env: { ...f.env, TMUX: startup.tmux, TMUX_PANE: startup.pane } });
  assert.equal(JSON.parse(inferred.stdout).from, child.id);
});

test('attach resolves the registered pane and rejects noninteractive use before changing focus', async t => {
  const f = await fixture(t);
  const { session } = await f.create('worker');
  const window = f.tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', session.tmuxSession, '/bin/cat');
  f.tmux('select-window', '-t', window);
  const service = new Service({ store: new Store(f.home), tmux: new (await import('../cli/tmux.mjs')).Tmux(f.socket) });
  const target = await service.attach('worker');
  assert.equal(target.pane, session.pane);
  assert.equal(target.session, session.tmuxSession);
  await assert.rejects(f.cli('attach', 'worker'), /interactive terminal/);
  assert.equal(f.tmux('display-message', '-p', '-t', session.tmuxSession, '#{window_id}'), window);
  // tmux accepts a pane ID as select-window's target, including an inactive one.
  f.tmux('select-window', '-t', target.pane);
  assert.equal(f.tmux('display-message', '-p', '-t', session.tmuxSession, '#{window_id}'),
    f.tmux('display-message', '-p', '-t', target.pane, '#{window_id}'));
});

test('CLI installer is idempotent and refuses to overwrite another command', async t => {
  const root = await mkdtemp('/tmp/dag-install-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = fileURLToPath(new URL('../cli/install.mjs', import.meta.url));
  await exec(process.execPath, [install, root]);
  assert.equal(await readlink(join(root, 'dag')), bin);
  await exec(process.execPath, [install, root]);
  await rm(join(root, 'dag'));
  await writeFile(join(root, 'dag'), 'existing command');
  await assert.rejects(exec(process.execPath, [install, root]), /has not been replaced/);
  assert.equal(await readFile(join(root, 'dag'), 'utf8'), 'existing command');
});

test('uncertain delivery is durable and never automatically retried', async t => {
  const root = await mkdtemp('/tmp/dag-state-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.locked(async state => {
    state.sessions.push({ id: 'receiver-id', name: 'receiver', status: 'ready' });
    await store.save(state);
  });
  let calls = 0;
  const tmux = { inspect: () => ({ online: true }), inject: async () => { calls++; throw new Error('Return failed after text was written'); } };
  const service = new Service({ store, tmux });
  const msg = await service.send('receiver', 'hello');
  assert.equal(msg.status, 'uncertain');
  await assert.rejects(service.readiness('ready', 'receiver'), /unconfirmed/);
  await service.send('receiver', 'later');
  assert.equal(calls, 1);
  await service.ack(msg.id, 'receiver');
  await service.readiness('ready', 'receiver');
  assert.equal(calls, 2);
});

test('dead lock owner is recovered and invalid state is not overwritten', async t => {
  const root = await mkdtemp('/tmp/dag-state-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await mkdir(join(root, 'lock'));
  await writeFile(join(root, 'lock', '2147483647-dead'), '');
  await store.locked(async state => { state.messages.push({ id: 'kept' }); await store.save(state); });
  assert.equal((await store.read()).messages[0].id, 'kept');
  await writeFile(store.file, '{broken');
  await assert.rejects(store.locked(() => assert.fail('must not enter callback')), SyntaxError);
  assert.equal(await readFile(store.file, 'utf8'), '{broken');
  await assert.rejects(stat(join(root, 'lock')), { code: 'ENOENT' });
});
