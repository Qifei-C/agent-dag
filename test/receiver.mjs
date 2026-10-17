// A real terminal process for tmux integration tests. Never evaluates input.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const sessions = JSON.parse(execFileSync('dag', ['sessions', '--json'], { encoding: 'utf8' }));
writeFileSync(file, JSON.stringify({ type: 'start', cwd: process.cwd(), args: process.argv.slice(3),
  sessionId: process.env.DAG_SESSION_ID, home: process.env.DAG_HOME,
  tmux: process.env.TMUX, pane: process.env.TMUX_PANE,
  self: sessions.find(s => s.id === process.env.DAG_SESSION_ID),
}) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(file, JSON.stringify({ type: 'input', line }) + '\n');
});
