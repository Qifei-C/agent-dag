import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Service } from './service.mjs';
import { Store } from './store.mjs';
import { Tmux } from './tmux.mjs';

const HELP = `dag — tmux sessions and recorded agent messages

  dag create NAME [--cwd DIR] [--role TEXT] [--parent NAME|none] [-- COMMAND ...]
  dag register NAME [--target PANE] [--role TEXT] [--parent NAME|none] [--replace]
  dag sessions [--watch]
  dag send NAME TEXT [--from NAME] [--reply-to ID] [--key KEY]
  dag send NAME --file PATH [--from NAME] [--reply-to ID]
  dag inbox [NAME] [--all]
  dag ack MESSAGE_ID [--session NAME]
  dag ready [NAME]                    Accept one queued/future terminal message
  dag busy [NAME]                     Queue incoming messages without injection
  dag attach NAME                    Focus the registered pane
  dag messages                       Show the complete message history

Options: --json, --home DIR, --socket PATH, --help
Environment: DAG_HOME, DAG_TMUX_SOCKET, DAG_SESSION_ID

create starts a detached tmux session (default: your shell). Commands after --
are executed as argv, not shell text. New sessions start with unknown readiness.
Use ready only when the pane can accept a prompt. After one injection it becomes
busy again. ack confirms receipt, not task completion. inbox never injects input.
Session and message IDs are stable; duplicate session names are rejected.
--key makes send retries idempotent for a sender/receiver pair.
register --replace preserves an offline session's identity and inbox on a new pane.
`;

const option = type => ({ type });
const OPTIONS = {
  create: { cwd: option('string'), role: option('string'), parent: option('string') },
  register: { target: option('string'), role: option('string'), parent: option('string'), replace: option('boolean') },
  sessions: { watch: option('boolean') },
  send: { from: option('string'), 'reply-to': option('string'), file: option('string'), key: option('string') },
  inbox: { all: option('boolean') },
  ack: { session: option('string') },
  ready: {}, busy: {}, attach: {}, messages: {},
};

// Terminal labels are untrusted too (roles, paths, imported session names).
const printable = text => String(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
function rows(sessions) {
  if (!sessions.length) return 'No registered sessions. Run dag create NAME -- COMMAND.';
  const out = ['SESSION                  STATUS    QUEUED  PANE    ROLE'];
  const visited = new Set();
  const walk = (s, depth) => {
    if (visited.has(s.id)) return;
    visited.add(s.id);
    const label = `${'  '.repeat(depth)}${s.name}`;
    out.push(`${printable(label).padEnd(25)}${s.status.padEnd(10)}${String(s.pending).padEnd(8)}${s.pane.padEnd(8)}${printable(s.role)}`);
    for (const child of sessions.filter(x => x.parentId === s.id)) walk(child, depth + 1);
  };
  for (const s of sessions.filter(s => !sessions.some(p => p.id === s.parentId))) walk(s, 0);
  for (const s of sessions) walk(s, 0);
  return out.join('\n');
}

function output(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) {
    if (!value.length) console.log('No messages.');
    for (const m of value) {
      console.log(`${m.id}  ${printable(m.fromName)} -> ${printable(m.toName)}  ${m.status}${m.replyTo ? `  reply-to=${m.replyTo}` : ''}`);
      console.log(`  ${JSON.stringify(m.text)}`);
      if (m.error) console.log(`  ${printable(m.error)}`);
    }
  } else if ('text' in value) {
    output([value], false);
  } else {
    console.log(`${value.name}  ${value.id}  ${value.status}  ${value.pane}`);
  }
}

export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help' || command === '-h') {
    console.log(HELP); return;
  }
  if (command === '--version') {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (!Object.hasOwn(OPTIONS, command)) throw new Error(`Unknown command: ${command}. Run dag --help.`);
  const separator = rest.indexOf('--');
  const launch = command === 'create' && separator >= 0 ? rest.slice(separator + 1) : [];
  const { values: opts, positionals: pos } = parseArgs({
    args: command === 'create' && separator >= 0 ? rest.slice(0, separator) : rest,
    allowPositionals: true, strict: true,
    options: { ...OPTIONS[command], json: option('boolean'), home: option('string'), socket: option('string'),
      help: { type: 'boolean', short: 'h' } },
  });
  if (opts.help) { console.log(HELP); return; }
  if (opts.watch && opts.json) throw new Error('--watch and --json cannot be combined.');
  const range = { create: [1, 1], register: [1, 1], sessions: [0, 0], send: [1, opts.file ? 1 : 2],
    inbox: [0, 1], ack: [1, 1], ready: [0, 1], busy: [0, 1], attach: [1, 1], messages: [0, 0] }[command];
  if (pos.length < range[0] || pos.length > range[1] || (command === 'send' && !opts.file && pos.length !== 2)) {
    throw new Error(`Invalid arguments for ${command}. Run dag --help.`);
  }
  const service = new Service({ store: new Store(opts.home), tmux: new Tmux(opts.socket) });
  let result;
  switch (command) {
    case 'create': result = await service.create(pos[0], { ...opts, command: launch }); break;
    case 'register': result = await service.register(pos[0], opts); break;
    case 'sessions': {
      if (opts.watch && !process.stdout.isTTY) throw new Error('--watch needs an interactive terminal.');
      do {
        const sessions = await service.sessions();
        if (opts.watch) process.stdout.write('\x1b[2J\x1b[H');
        if (opts.json) console.log(JSON.stringify(sessions, null, 2));
        else console.log(rows(sessions));
        if (opts.watch) await delay(2000);
      } while (opts.watch);
      return;
    }
    case 'send': result = await service.send(pos[0], opts.file ? await readFile(opts.file, 'utf8') : pos[1],
      { from: opts.from, replyTo: opts['reply-to'], key: opts.key }); break;
    case 'ready': case 'busy': result = await service.readiness(command, pos[0]); break;
    case 'inbox': result = await service.inbox(pos[0], opts.all); break;
    case 'ack': result = await service.ack(pos[0], opts.session); break;
    case 'messages': result = (await service.store.snapshot()).messages; break;
    case 'attach': {
      if (!process.env.TMUX && !process.stdin.isTTY) throw new Error('attach needs an interactive terminal.');
      const target = await service.attach(pos[0]);
      const tmux = new Tmux(target.socket);
      if (process.env.TMUX) {
        // A switch-client must execute against the caller's server. tmux
        // cannot switch an existing client onto a different server socket.
        const currentSocket = Tmux.callerSocket();
        if (currentSocket !== target.socket) throw new Error('Target uses another tmux server; attach from outside tmux.');
        tmux.run(['select-window', '-t', target.pane]);
        tmux.run(['select-pane', '-t', target.pane]);
        tmux.run(['switch-client', '-t', target.session]);
      } else {
        tmux.run(['select-window', '-t', target.pane]);
        tmux.run(['select-pane', '-t', target.pane]);
        await new Promise((resolve, reject) => {
          const child = spawn('tmux', ['-S', target.socket, 'attach-session', '-t', target.session], { stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(`tmux attach exited ${code}`)));
        });
      }
      return;
    }
  }
  output(result, opts.json);
}
