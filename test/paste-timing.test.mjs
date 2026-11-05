import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmux } from '../cli/tmux.mjs';

test('delivery uses a private bracketed paste and waits beyond Codex Enter suppression', async t => {
  const original = Tmux.prototype.run;
  t.after(() => { Tmux.prototype.run = original; });
  const calls = [];
  Tmux.prototype.run = function (args) {
    calls.push({ args, at: performance.now() });
    if (args[0] === 'display-message') return '%0\t$0\treceiver\t/tmp/test\t0\t/tmp\tid\t0\t0\t0';
    return '';
  };
  const text = 'literal 中文 "quotes" $(do-not-run);';
  await new Tmux('/tmp/test').inject({ socket: '/tmp/test', pane: '%0', id: 'id' }, text);
  const set = calls.find(c => c.args[0] === 'set-buffer');
  const paste = calls.find(c => c.args[0] === 'paste-buffer');
  const enter = calls.find(c => c.args[0] === 'send-keys');
  assert.equal(set.args.at(-1), text);
  assert.match(set.args[2], /^dag-[0-9a-f-]+$/);
  assert.deepEqual(paste.args, ['paste-buffer', '-p', '-d', '-b', set.args[2], '-t', '%0']);
  assert.deepEqual(enter.args, ['send-keys', '-t', '%0', 'Enter']);
  assert.ok(enter.at - paste.at >= 650, 'must exceed the 120ms paste Enter suppression window');
  assert.equal(calls.filter(c => c.args[0] === 'send-keys').length, 1, 'never send a blind second Enter');
});

test('failed paste cleans only its own buffer and never sends Enter', async t => {
  const original = Tmux.prototype.run;
  t.after(() => { Tmux.prototype.run = original; });
  const calls = [];
  Tmux.prototype.run = function (args) {
    calls.push(args);
    if (args[0] === 'display-message') return '%0\t$0\treceiver\t/tmp/test\t0\t/tmp\tid\t0\t0\t0';
    if (args[0] === 'paste-buffer') throw new Error('paste failed');
    return '';
  };
  await assert.rejects(new Tmux('/tmp/test').inject({ socket: '/tmp/test', pane: '%0', id: 'id' }, 'hello'), /paste failed/);
  assert.deepEqual(calls.at(-1), ['delete-buffer', '-b', calls.find(c => c[0] === 'set-buffer')[2]]);
  assert.ok(!calls.some(c => c[0] === 'send-keys'));
});
