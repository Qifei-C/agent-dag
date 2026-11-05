import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../cli/store.mjs';
import { isGoneError } from '../cli/tmux.mjs';
import { offlineTtlMs, watchIntervalMs } from '../cli/presence.mjs';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/dag', import.meta.url));
const receiver = fileURLToPath(new URL('./receiver.mjs', import.meta.url));
const cleanEnv = { ...process.env, DAG_WATCH: 'off' };
for (const key of ['DAG_HOME', 'DAG_SESSION_ID', 'DAG_TMUX_SOCKET', 'DAG_OFFLINE_TTL', 'DAG_WATCH_INTERVAL', 'TMUX', 'TMUX_PANE']) delete cleanEnv[key];

async function eventually(check, message = 'Timed out.') {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(30); }
  assert.fail(message);
}

async function lines(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t, extraEnv = {}) {
  const root = await mkdtemp('/tmp/dag-offline-');
  const home = join(root, 'registry');
  const socket = join(root, 'tmux.sock');
  const env = { ...cleanEnv, DAG_HOME: home, DAG_TMUX_SOCKET: socket, ...extraEnv };
  t.after(async () => {
    spawnSync('pkill', ['-f', `dag watch --home ${home}`]);
    spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  });
  const start = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'anchor', '/bin/cat'],
    { encoding: 'utf8', env: cleanEnv });
  assert.equal(start.status, 0, `isolated tmux server: ${start.stderr}`);
  const run = async (overrides, ...args) => (await exec(process.execPath, [bin, ...args], { env: { ...env, ...overrides } })).stdout;
  const cli = async (...args) => JSON.parse(await run({}, ...args, '--json'));
  const tmux = (...args) => {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const create = async (name, ...args) => {
    const log = join(root, `${name}.jsonl`);
    const { stdout } = await exec(process.execPath, [bin, 'create', name, '--json', ...args, '--', process.execPath, receiver, log], { env });
    const session = JSON.parse(stdout);
    await eventually(async () => (await lines(log)).length > 0, `receiver ${name} did not start`);
    return { session, log };
  };
  const notices = async () => (await new Store(home).snapshot()).messages.filter(m => m.from === 'dag');
  return { root, home, socket, env, run, cli, tmux, create, notices, store: new Store(home) };
}

const backdate = (f, name, ms = 3_600_000 * 24) => f.store.locked(async state => {
  state.sessions.find(s => s.name === name).offlineSince = new Date(Date.now() - ms).toISOString();
  await f.store.save(state);
});

test('classifier treats only proof of absence as gone', () => {
  assert.equal(isGoneError('tmux: no server running on /tmp/x'), true);
  assert.equal(isGoneError('tmux: error connecting to /tmp/x (No such file or directory)'), false, 'a private /tmp looks the same');
  assert.equal(isGoneError('tmux: error connecting to /tmp/x (Connection refused)'), true);
  assert.equal(isGoneError("tmux: can't find pane: %9"), true);
  assert.equal(isGoneError('tmux: error connecting to /tmp/x (Permission denied)'), false);
  assert.equal(isGoneError('tmux: error connecting to /tmp/x (Operation not permitted)'), false);
  assert.equal(isGoneError('tmux: spawnSync tmux ETIMEDOUT'), false);
  assert.equal(isGoneError('tmux: spawnSync tmux ENOENT'), false);
  assert.equal(isGoneError('Could not resolve tmux pane.'), false);
});

test('offline TTL defaults to ten minutes, accepts zero and rejects invalid values', () => {
  assert.equal(offlineTtlMs({}), 600_000);
  assert.equal(offlineTtlMs({ DAG_OFFLINE_TTL: '0' }), 0);
  assert.equal(offlineTtlMs({ DAG_OFFLINE_TTL: '90' }), 90_000);
  for (const bad of ['abc', '-1', '1.5', '', ' ']) assert.throws(() => offlineTtlMs({ DAG_OFFLINE_TTL: bad }), /DAG_OFFLINE_TTL/);
});

test('watch interval defaults to five seconds and rejects invalid values', () => {
  assert.equal(watchIntervalMs({}), 5000);
  assert.equal(watchIntervalMs({ DAG_WATCH_INTERVAL: '0.5' }), 500);
  for (const bad of ['0', '-1', 'x', '']) assert.throws(() => watchIntervalMs({ DAG_WATCH_INTERVAL: bad }), /DAG_WATCH_INTERVAL/);
});

test('unregister --offline leaves sessions with unknown presence alone', async t => {
  const f = await fixture(t);
  await f.create('worker');
  assert.deepEqual(JSON.parse(await f.run({ PATH: '/nonexistent' }, 'unregister', '--offline', '--json')), []);
  assert.equal((await f.store.snapshot()).sessions.length, 1);
});

test('an invalid TTL fails the command instead of being ignored', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ DAG_OFFLINE_TTL: 'soon' }, 'sessions'), /DAG_OFFLINE_TTL/);
});

test('send reports receiver presence for online, offline and idempotent retries', async t => {
  const f = await fixture(t);
  const { session } = await f.create('worker');
  const online = await f.cli('send', 'worker', 'hello');
  assert.equal(online.receiverPresence.state, 'online');
  assert.equal(online.receiverPresence.since, undefined);

  f.tmux('kill-session', '-t', session.tmuxSession);
  const offline = await f.cli('send', 'worker', 'are you there', '--key', 'k1');
  assert.equal(offline.status, 'queued');
  assert.equal(offline.receiverPresence.state, 'offline');
  assert.ok(Date.parse(offline.receiverPresence.since));
  assert.equal(Date.parse(offline.receiverPresence.removesAt), Date.parse(offline.receiverPresence.since) + 600_000);

  const retry = await f.cli('send', 'worker', 'are you there', '--key', 'k1');
  assert.equal(retry.id, offline.id);
  assert.equal(retry.receiverPresence.state, 'offline');

  const text = await f.run({}, 'send', 'worker', 'plain output');
  assert.match(text, /Receiver offline/);
  assert.match(text, /register worker --target PANE --replace/);
});

test('going offline notifies parent, children and waiting senders exactly once', async t => {
  const f = await fixture(t);
  const parent = await f.create('parent');
  const target = await f.create('target', '--parent', 'parent');
  const grandchild = await f.create('grandchild', '--parent', 'target');
  const waiter = await f.create('waiter');
  const answered = await f.create('answered');
  const bystander = await f.create('bystander');

  await f.cli('send', 'target', 'please review', '--from', 'waiter');
  const question = await f.cli('send', 'target', 'question', '--from', 'answered');
  await f.cli('ack', question.id, '--session', 'target');
  await f.cli('send', 'answered', 'answer', '--from', 'target', '--reply-to', question.id);
  await f.cli('ready', 'waiter');

  f.tmux('kill-session', '-t', target.session.tmuxSession);
  await f.cli('sessions');
  const first = await f.notices();
  assert.deepEqual(new Set(first.map(m => m.toName)), new Set(['parent', 'grandchild', 'waiter']));
  assert.ok(first.every(m => m.event === 'session-offline' && m.about === target.session.id && m.fromName === 'dag'));
  assert.ok(first.every(m => m.text.includes('target')));

  await eventually(async () => (await lines(waiter.log)).some(l => l.line?.includes('target')),
    'ready recipient should receive the notice in its pane');
  assert.equal((await f.notices()).find(m => m.toName === 'waiter').status, 'injected');
  assert.equal((await lines(bystander.log)).length, 1);
  assert.equal((await lines(answered.log)).length, 1);

  await f.cli('sessions');
  await f.cli('inbox', 'parent');
  assert.equal((await f.notices()).length, 3, 'repeat observations do not repeat notices');
  assert.ok(parent && grandchild);
});

test('an offline recipient gets no notice and busy recipients keep it queued', async t => {
  const f = await fixture(t);
  const a = await f.create('a');
  const b = await f.create('b', '--parent', 'a');
  f.tmux('kill-session', '-t', a.session.tmuxSession);
  f.tmux('kill-session', '-t', b.session.tmuxSession);
  await f.cli('sessions');
  assert.deepEqual(await f.notices(), []);

  const c = await f.create('c');
  await f.create('d', '--parent', 'c');
  f.tmux('kill-session', '-t', c.session.tmuxSession);
  await f.cli('busy', 'd');
  const notices = await f.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, 'queued');
});

test('recovery within grace clears the clock, keeps identity and announces return', async t => {
  const f = await fixture(t);
  await f.create('parent');
  const { session } = await f.create('worker', '--parent', 'parent');
  const pending = await f.cli('send', 'worker', 'pending task');
  f.tmux('kill-session', '-t', session.tmuxSession);
  assert.ok((await f.cli('sessions')).find(s => s.name === 'worker').offlineSince);

  const pane = f.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'next', '/bin/cat');
  const rebound = await f.cli('register', 'worker', '--target', pane, '--replace');
  assert.equal(rebound.id, session.id);
  const after = (await f.cli('sessions')).find(s => s.name === 'worker');
  assert.equal(after.status, 'unknown');
  assert.equal(after.offlineSince, undefined);
  assert.equal((await f.cli('inbox', 'worker'))[0].id, pending.id);
  const events = (await f.notices()).map(m => `${m.toName}:${m.event}`);
  assert.deepEqual(events, ['parent:session-offline', 'parent:session-online']);
});

test('a session offline for the full grace is removed automatically and its name reused', async t => {
  const f = await fixture(t);
  const parent = await f.create('parent');
  const { session } = await f.create('worker', '--parent', 'parent');
  const { session: child } = await f.create('child', '--parent', 'worker');
  const message = await f.cli('send', 'worker', 'undelivered', '--from', 'parent');
  f.tmux('kill-session', '-t', session.tmuxSession);
  await f.cli('sessions');
  assert.ok((await f.cli('sessions')).some(s => s.name === 'worker'), 'retained during grace');

  await backdate(f, 'worker');
  const sessions = await f.cli('sessions');
  assert.equal(sessions.some(s => s.name === 'worker'), false);
  assert.equal(sessions.find(s => s.id === child.id).parentId, undefined);
  const stored = (await f.store.snapshot()).messages.find(m => m.id === message.id);
  assert.equal(stored.status, 'orphaned');
  assert.ok(Date.parse(stored.orphanedAt));
  const removal = (await f.notices()).filter(m => m.event === 'session-removed');
  assert.deepEqual(removal.map(m => m.toName), ['parent']);
  assert.ok(removal[0].text.includes(message.id));
  assert.ok(parent);

  const reused = await f.create('worker');
  assert.notEqual(reused.session.id, session.id);
  assert.deepEqual(await f.cli('inbox', 'worker'), []);
});

test('TTL zero removes on first observation without a separate offline notice', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  await f.create('parent');
  const { session } = await f.create('worker', '--parent', 'parent');
  f.tmux('kill-session', '-t', session.tmuxSession);
  assert.deepEqual((await f.cli('sessions')).map(s => s.name), ['parent']);
  assert.deepEqual((await f.notices()).map(m => m.event).filter(e => e === 'session-offline'), []);
});

test('a killed tmux server counts as offline and is cleaned', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  await f.create('worker');
  spawnSync('tmux', ['-S', f.socket, 'kill-server']);
  await eventually(() => spawnSync('tmux', ['-S', f.socket, 'list-sessions']).status !== 0);
  assert.deepEqual(await f.cli('sessions'), []);
});

test('an unavailable tmux client never removes or starts an offline clock', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  await f.create('worker');
  const output = await f.run({ PATH: '/nonexistent' }, 'sessions', '--json');
  const [session] = JSON.parse(output);
  assert.equal(session.name, 'worker');
  assert.equal(session.presence.state, 'unknown');
  assert.equal(session.status, 'offline?');
  assert.equal(session.offlineSince, undefined);
  assert.equal((await f.store.snapshot()).sessions.length, 1);
  assert.equal((await f.cli('sessions'))[0].presence.state, 'online');
});

test('a malformed pane reply is unknown, not gone', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  const cwd = join(f.root, 'tab\tpath');
  spawnSync('mkdir', [cwd]);
  const pane = f.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'tabbed', '-c', cwd, '/bin/cat');
  await f.store.locked(async state => {
    state.sessions.push({ id: 'tab-id', name: 'tabbed', socket: f.socket, pane, status: 'unknown', role: '',
      availability: { state: 'available' }, createdAt: new Date().toISOString() });
    await f.store.save(state);
  });
  f.tmux('set-option', '-p', '-t', pane, '@dag_session_id', 'tab-id');
  const [session] = await f.cli('sessions');
  assert.ok(['online', 'unknown'].includes(session.presence.state));
  assert.equal((await f.store.snapshot()).sessions.length, 1);
});

test('unregister orphans unconfirmed messages and notifies agent senders', async t => {
  const f = await fixture(t);
  const sender = await f.create('sender');
  const related = await f.create('related');
  await f.create('worker', '--parent', 'related');
  const queued = await f.cli('send', 'worker', 'queued one', '--from', 'sender');
  const sending = await f.cli('send', 'worker', 'sending one', '--from', 'sender');
  const uncertain = await f.cli('send', 'worker', 'uncertain one', '--from', 'sender');
  const injected = await f.cli('send', 'worker', 'injected one', '--from', 'sender');
  const acked = await f.cli('send', 'worker', 'acked one', '--from', 'sender');
  const person = await f.cli('send', 'worker', 'from a person');
  await f.store.locked(async state => {
    const set = (id, status) => { state.messages.find(m => m.id === id).status = status; };
    set(sending.id, 'sending'); set(uncertain.id, 'uncertain'); set(injected.id, 'injected'); set(acked.id, 'acknowledged');
    await f.store.save(state);
  });
  await f.cli('unregister', 'worker');
  const { messages } = await f.store.snapshot();
  const statusOf = id => messages.find(m => m.id === id);
  for (const m of [queued, sending, uncertain, person]) assert.equal(statusOf(m.id).status, 'orphaned');
  assert.equal(statusOf(sending.id).orphanedFrom, 'sending');
  assert.equal(statusOf(injected.id).status, 'injected');
  assert.equal(statusOf(acked.id).status, 'acknowledged');

  const notices = (await f.notices()).filter(m => m.event === 'session-removed');
  assert.deepEqual(new Set(notices.map(m => m.toName)), new Set(['sender', 'related']));
  const toSender = notices.find(m => m.toName === 'sender');
  assert.ok(toSender.text.includes(queued.id) && !toSender.text.includes(person.id) && !toSender.text.includes(injected.id));
  assert.ok(sender && related);
});

test('a missing socket is unknown for a session from this boot, gone for one from before it', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  const { session: current } = await f.create('current');
  const { session: previous } = await f.create('previous');
  await f.store.locked(async state => {
    for (const s of state.sessions) s.socket = join(f.root, 'hidden', 'tmux.sock');
    state.sessions.find(s => s.id === previous.id).updatedAt = '2000-01-01T00:00:00.000Z';
    await f.store.save(state);
  });
  const sessions = await f.cli('sessions');
  assert.deepEqual(sessions.map(s => s.id), [current.id]);
  assert.equal(sessions[0].presence.state, 'unknown');
  assert.equal(sessions[0].offlineSince, undefined);
  assert.deepEqual(await f.notices(), []);
});

test('a notice that cannot be injected stays queued and does not block its recipient', async t => {
  const f = await fixture(t);
  const parent = await f.create('parent');
  const { session } = await f.create('worker', '--parent', 'parent');
  await f.cli('ready', 'parent');
  f.tmux('copy-mode', '-t', parent.session.pane);
  f.tmux('kill-session', '-t', session.tmuxSession);
  await f.cli('sessions');
  const [stuck] = await f.notices();
  assert.equal(stuck.status, 'queued');
  assert.match(stuck.error, /copy mode/);
  assert.equal((await f.cli('sessions')).find(s => s.name === 'parent').status, 'ready');

  f.tmux('send-keys', '-t', parent.session.pane, '-X', 'cancel');
  assert.equal((await f.cli('ready', 'parent')).status, 'busy');
  assert.equal((await f.notices())[0].status, 'injected');
  assert.equal((await f.notices())[0].error, undefined);
});

test('an interrupted notice never blocks ready or resume, but other messages still do', async t => {
  const f = await fixture(t);
  await f.create('worker');
  const setNotice = status => f.store.locked(async state => {
    const session = state.sessions[0];
    state.messages = [{ id: 'n1', from: 'dag', fromName: 'dag', to: session.id, toName: session.name, text: 'x', status, createdAt: new Date().toISOString() }];
    await f.store.save(state);
  });
  for (const status of ['sending', 'uncertain']) {
    await setNotice(status);
    await f.cli('ready', 'worker');
    await f.cli('busy', 'worker');
    await f.cli('resume', 'worker');
  }
  const message = await f.cli('send', 'worker', 'real');
  await f.store.locked(async state => {
    state.messages.find(m => m.id === message.id).status = 'uncertain';
    await f.store.save(state);
  });
  await assert.rejects(f.cli('ready', 'worker'), /unconfirmed/);
});

test('reserved sender names cannot be registered', async t => {
  const f = await fixture(t);
  await assert.rejects(f.cli('create', 'dag'), /reserved/);
  await assert.rejects(f.cli('create', 'person'), /reserved/);
  const pane = f.tmux('display-message', '-p', '-t', 'anchor', '#{pane_id}');
  await assert.rejects(f.cli('register', 'dag', '--target', pane), /reserved/);
});

test('the dashboard labels unreachable tmux differently from offline', async t => {
  const f = await fixture(t);
  await f.create('worker');
  const view = JSON.parse(await f.run({ PATH: '/nonexistent' }, 'view', '--once', '--json'));
  const label = Object.values(view.nodes).find(n => n.label?.startsWith('worker')).label;
  assert.match(label, /\[unreachable\]/);
  assert.doesNotMatch(label, /\[offline\]/);
});

test('a hung tmux server costs one short timeout per command and removes nothing', async t => {
  const f = await fixture(t, { DAG_OFFLINE_TTL: '0' });
  const { session } = await f.create('a');
  await f.create('b');
  await f.create('c');
  const server = Number(f.tmux('display-message', '-p', '#{pid}'));
  process.kill(server, 'SIGSTOP');
  t.after(() => { try { process.kill(server, 'SIGCONT'); } catch {} });
  const started = Date.now();
  const inbox = JSON.parse(await f.run({}, 'inbox', session.id, '--json'));
  const elapsed = Date.now() - started;
  process.kill(server, 'SIGCONT');
  assert.deepEqual(inbox, []);
  assert.ok(elapsed < 4000, `took ${elapsed}ms`);
  assert.equal((await f.store.snapshot()).sessions.length, 3);
});

test('sessions output shows when an offline record will be removed', async t => {
  const f = await fixture(t);
  const { session } = await f.create('worker');
  f.tmux('kill-session', '-t', session.tmuxSession);
  const text = await f.run({}, 'sessions');
  assert.match(text, /auto-removes/);
  assert.match(text, /register worker --target PANE --replace/);
  const [json] = await f.cli('sessions');
  assert.equal(json.presence.state, 'offline');
  assert.ok(Date.parse(json.presence.removesAt));
});

const watcherEnv = { DAG_WATCH: 'on', DAG_WATCH_INTERVAL: '0.1' };
const watcherPids = home => spawnSync('pgrep', ['-f', `dag watch --home ${home}`], { encoding: 'utf8' })
  .stdout.trim().split('\n').filter(Boolean);

test('the watcher notifies and cleans with no further dag commands, then exits', async t => {
  const f = await fixture(t, { ...watcherEnv, DAG_OFFLINE_TTL: '1' });
  const parent = await f.create('parent');
  await f.cli('ready', 'parent');
  const { session } = await f.create('worker', '--parent', 'parent');
  await eventually(() => watcherPids(f.home).length === 1, 'watcher should start');

  f.tmux('kill-session', '-t', session.tmuxSession);
  await eventually(async () => (await lines(parent.log)).some(l => l.line?.includes('worker')),
    'watcher should inject the offline notice');
  await eventually(async () => !(await f.store.read()).sessions.some(s => s.name === 'worker'),
    'watcher should remove the record after grace');

  spawnSync('tmux', ['-S', f.socket, 'kill-server']);
  await eventually(() => watcherPids(f.home).length === 0, 'watcher should exit when no sessions remain');
  await assert.rejects(stat(join(f.home, 'watcher.pid')), { code: 'ENOENT' });
});

test('concurrent commands start one watcher and a stale pid file is taken over', async t => {
  const f = await fixture(t, watcherEnv);
  await f.create('worker');
  await Promise.all(Array.from({ length: 6 }, () => f.cli('sessions')));
  await eventually(() => watcherPids(f.home).length === 1);
  await delay(400);
  assert.equal(watcherPids(f.home).length, 1);

  spawnSync('pkill', ['-f', `dag watch --home ${f.home}`]);
  await eventually(() => watcherPids(f.home).length === 0);
  const pidFile = join(f.home, 'watcher.pid');
  await writeFile(pidFile, '2147483647\n');
  const old = new Date(Date.now() - 3_600_000);
  await utimes(pidFile, old, old);
  await f.cli('sessions');
  await eventually(() => watcherPids(f.home).length === 1, 'stale pid file should not block a new watcher');
});

test('the watcher exits without recreating a deleted home', async t => {
  const f = await fixture(t, watcherEnv);
  await f.create('worker');
  await eventually(() => watcherPids(f.home).length === 1);
  await rm(f.home, { recursive: true, force: true });
  await eventually(() => watcherPids(f.home).length === 0, 'watcher should exit');
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('DAG_WATCH=off starts no watcher', async t => {
  const f = await fixture(t);
  await f.create('worker');
  await f.cli('sessions');
  await delay(200);
  assert.deepEqual(watcherPids(f.home), []);
  await assert.rejects(stat(join(f.home, 'watcher.pid')), { code: 'ENOENT' });
});
