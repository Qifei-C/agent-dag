import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

// Used by Claude command hooks; an SDK host may also forward rate_limit_event
// JSON here. This bridge records availability and never sends terminal input.
export async function runClaudeHook(input = process.stdin) {
  if (!process.env.DAG_SESSION_ID && !process.env.TMUX_PANE) return;
  // The pane plugin also works without the separately installed CLI/dependencies.
  // Avoid loading its adapter stack for unrelated interactive Claude sessions.
  const store = new Store();
  if (!process.env.DAG_SESSION_ID && !(await store.read()).sessions.length) return;
  let text = '';
  for await (const chunk of input) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error('Claude hook input exceeds 64 KiB.');
  }
  const { Service } = await import('./service.mjs');
  await new Service({ store }).observeClaude(JSON.parse(text));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runClaudeHook(); }
  catch (error) { console.error(`dag claude hook: ${error.message}`); process.exitCode = 1; }
}
