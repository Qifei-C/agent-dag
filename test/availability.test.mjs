import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Store } from '../cli/store.mjs';
import { Service } from '../cli/service.mjs';
import { CodexAdapter, observationSink } from '../cli/codex.mjs';
import { availabilityOf, claudeLimit, codexLimit } from '../cli/availability.mjs';

async function fixture(t, { native = true, codex } = {}) {
  const home = await mkdtemp('/tmp/dag-availability-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(home);
  await store.locked(async state => {
    state.sessions.push({ id: 's', name: 'worker', status: 'ready', createdAt: new Date().toISOString(),
      ...(native ? { adapter: 'codex', codex: { threadId: 'root' } } : {}) });
    await store.save(state);
  });
  const calls = [];
  const service = new Service({ store,
    tmux: { inspect: () => ({ online: true }), inject: async (_session, text) => { calls.push(text); } },
    codex: codex || { submit: async (_binding, text) => { calls.push(text); } } });
  return { service, store, calls, sink: observationSink(store, 's', 'root') };
}

test('pause is independent of readiness; resume drains only queued messages once', async t => {
  const f = await fixture(t);
  const accepted = await f.service.send('worker', 'already accepted');
  const held = await f.service.pause('worker', { reason: 'Usage limit reached' });
  assert.equal(held.status, 'ready');
  assert.equal(held.availability.state, 'blocked');
  const first = await f.service.send('worker', 'first', { key: 'first' });
  assert.equal(first.status, 'queued');
  assert.equal(first.receiverAvailability.reason, 'Usage limit reached');
  assert.equal((await f.service.send('worker', 'first', { key: 'first' })).id, first.id);
  await f.service.send('worker', 'second');
  await f.service.readiness('ready', 'worker');
  await f.service.flush('worker');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.sessions())[0].pending, 2);
  await f.service.resume('worker');
  assert.equal(f.calls.length, 3);
  const history = (await f.store.snapshot()).messages;
  assert.equal(history.find(m => m.id === accepted.id).status, 'submitted');
  assert.ok(history.every(m => m.status === 'submitted'));
  await f.service.resume('worker');
  assert.equal(f.calls.length, 3, 'resume never replays accepted messages');
});

test('resume respects busy and unknown readiness; tmux still injects only once per ready', async t => {
  const f = await fixture(t, { native: false });
  await f.service.pause('worker');
  await f.service.send('worker', 'one');
  await f.service.send('worker', 'two');
  await f.service.resume('worker');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.inbox('worker'))[0].status, 'injected');
  await f.service.pause('worker');
  await f.service.resume('worker');
  assert.equal(f.calls.length, 1, 'busy terminal is not marked ready by resume');
  await f.store.locked(async state => { state.sessions[0].status = 'unknown'; await f.store.save(state); });
  await f.service.pause('worker');
  await f.service.resume('worker');
  assert.equal(f.calls.length, 1, 'unknown terminal is not marked ready by resume');
  await f.service.readiness('ready', 'worker');
  assert.equal(f.calls.length, 2);
});

test('resume respects native busy and refuses uncertain/sending without changing the hold', async t => {
  const f = await fixture(t);
  await f.service.readiness('busy', 'worker');
  await f.service.pause('worker');
  const message = await f.service.send('worker', 'held');
  await f.service.resume('worker');
  assert.equal(f.calls.length, 0);
  for (const status of ['sending', 'uncertain']) {
    await f.service.pause('worker');
    await f.store.locked(async state => { state.messages[0].status = status; await f.store.save(state); });
    await assert.rejects(f.service.resume('worker'), /unconfirmed/);
    assert.equal((await f.service.sessions())[0].availability.state, 'blocked');
  }
  await f.service.ack(message.id, 'worker');
  await f.service.resume('worker');
  await f.service.readiness('ready', 'worker');
  assert.equal(f.calls.length, 0, 'acknowledged messages are never replayed');
});

test('cooldown reset is informational and old registries default to available', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.service.sessions())[0].availability, { state: 'available' });
  const until = new Date(Date.now() + 60000).toISOString();
  const paused = await f.service.pause('worker', { until });
  assert.equal(paused.availability.state, 'cooldown');
  assert.equal(paused.availability.retryAt, until);
  await f.store.locked(async state => {
    state.sessions[0].availability.retryAt = '2000-01-01T00:00:00.000Z';
    await f.store.save(state);
  });
  assert.equal((await f.service.send('worker', 'still held')).status, 'queued');
  assert.equal(f.calls.length, 0, 'a clock passing the reset time is not a recovery signal');
  await assert.rejects(f.service.pause('worker', { until: '1am' }), /future ISO/);
  await assert.rejects(f.service.pause('worker', { until: '2000-01-01T00:00:00Z' }), /future ISO/);
  await assert.rejects(f.service.pause('worker', { reason: ' ' }), /reason/);
});

test('Codex root errors hold new messages; child errors, idle and successful turns do not change the hold', async t => {
  const f = await fixture(t);
  const accepted = await f.service.send('worker', 'already submitted');
  const error = { codexErrorInfo: 'usageLimitExceeded', message: 'quota exhausted' };
  await f.sink.push({ method: 'error', params: { threadId: 'child', error, willRetry: false } });
  assert.equal(availabilityOf((await f.store.snapshot()).sessions[0]).state, 'available');
  await f.sink.push({ method: 'error', params: { threadId: 'root', error, willRetry: false } });
  const blocked = (await f.service.sessions())[0].availability;
  assert.equal(blocked.code, 'usageLimitExceeded');
  assert.equal(blocked.source, 'codex');
  await f.sink.push({ method: 'turn/completed', params: { threadId: 'root', turn: { status: 'failed', error } } });
  assert.deepEqual((await f.service.sessions())[0].availability, blocked, 'duplicate failure keeps original detection time');
  await f.sink.push({ method: 'thread/started', params: { thread: { id: 'root', status: { type: 'idle' } } } });
  await f.sink.push({ method: 'turn/completed', params: { threadId: 'root', turn: { status: 'completed' } } });
  const held = await f.service.send('worker', 'later');
  assert.equal(held.status, 'queued');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.inbox('worker')).find(m => m.id === accepted.id).status, 'submitted');
  await f.service.pause('worker', { reason: 'Operator hold' });
  await f.sink.push({ method: 'error', params: { threadId: 'root', error, willRetry: true } });
  assert.equal((await f.service.sessions())[0].availability.reason, 'Operator hold');
});

test('Codex recognizes failed-turn limit codes but never guesses from error text', async t => {
  const f = await fixture(t);
  await f.sink.push({ method: 'turn/completed', params: { threadId: 'root', turn: {
    status: 'failed', error: { codexErrorInfo: 'rateLimitExceeded', message: 'wait' },
  } } });
  assert.equal((await f.service.sessions())[0].availability.state, 'cooldown');
  assert.equal(codexLimit({ message: 'Usage limit reached' }), undefined);
  assert.equal(codexLimit({ codexErrorInfo: 'other', message: 'rate limit' }), undefined);
  assert.equal(codexLimit({ codexErrorInfo: 'sessionBudgetExceeded' }).state, 'blocked');
});

test('preflight rejection keeps a message queued; queue-process failure stays uncertain', async t => {
  let fail = true, queueCalls = 0;
  const adapter = new CodexAdapter({ rpc: () => ({
    connect: async function () { return this; }, close() {},
    request: async () => {
      if (fail) throw Object.assign(new Error('limited before submission'), { data: { codexErrorInfo: 'usageLimitExceeded', message: 'quota' } });
      return { thread: { id: 'root' } };
    },
  }), execute: async () => { queueCalls++; } });
  const f = await fixture(t, { codex: adapter });
  const message = await f.service.send('worker', 'not sent');
  assert.equal(message.status, 'queued');
  assert.equal(queueCalls, 0);
  assert.equal(message.receiverAvailability.state, 'blocked');
  fail = false;
  await f.service.resume('worker');
  assert.equal(queueCalls, 1);
  assert.equal((await f.service.inbox('worker'))[0].error, undefined);
  adapter.execute = async () => {
    throw Object.assign(new Error('usage limit after queue invocation'), { data: { codexErrorInfo: 'usageLimitExceeded' } });
  };
  assert.equal((await f.service.send('worker', 'unknown outcome')).status, 'uncertain');
  await assert.rejects(f.service.resume('worker'), /unconfirmed/);
});

test('Claude structured errors and SDK reset timestamps are recognized without parsing terminal text', () => {
  assert.equal(claudeLimit({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests' }).state, 'cooldown');
  assert.equal(claudeLimit({ hook_event_name: 'StopFailure', error: 'billing_error' }).state, 'blocked');
  assert.equal(claudeLimit({ hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: "You've hit your session limit · resets 1am (America/New_York)" }), undefined);
  assert.equal(claudeLimit({ hook_event_name: 'StopFailure', error: 'rate_limit', agent_id: 'child' }), undefined);
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792472400 } };
  assert.equal(claudeLimit(event).retryAt, new Date(1792472400 * 1000).toISOString());
  assert.equal(claudeLimit({ ...event, rate_limit_info: { status: 'allowed_warning' } }), undefined);
});
