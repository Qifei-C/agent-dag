import { spawn } from 'node:child_process';
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { watchIntervalMs } from './presence.mjs';

const BIN = fileURLToPath(new URL('../bin/dag', import.meta.url));
const MIN_STALE_MS = 15000;
const INHERITED_IDENTITY = ['DAG_SESSION_ID', 'DAG_TMUX_SOCKET', 'TMUX', 'TMUX_PANE', 'CLAUDECODE', 'CODEX_THREAD_ID'];

const pidFile = home => join(home, 'watcher.pid');
const errorFile = home => join(home, 'watcher.error');

const isAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};

async function readPid(home) {
  try { return Number((await readFile(pidFile(home), 'utf8')).trim()); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// The heartbeat stops a recycled PID from blocking the watcher indefinitely.
async function ownerIsFresh(home, intervalMs) {
  const pid = await readPid(home);
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false;
  const { mtimeMs } = await stat(pidFile(home));
  return Date.now() - mtimeMs < Math.max(MIN_STALE_MS, intervalMs * 3);
}

export async function ensureWatcher(home, { env = process.env } = {}) {
  if (env.DAG_WATCH === 'off') return;
  if (await ownerIsFresh(home, watchIntervalMs(env))) return;
  const childEnv = { ...env };
  for (const key of INHERITED_IDENTITY) delete childEnv[key];
  // Detached from the calling pane so closing that pane cannot stop the watcher.
  const child = spawn(process.execPath, [BIN, 'watch', '--home', home],
    { detached: true, stdio: 'ignore', cwd: '/', env: childEnv });
  child.once('error', error => console.error(`dag: could not start watcher: ${error.message}`));
  child.unref();
}

async function claim(store, intervalMs) {
  try { await stat(store.file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return store.locked(async () => {
    if (await ownerIsFresh(store.home, intervalMs)) return false;
    await writeFile(pidFile(store.home), `${process.pid}\n`, { mode: 0o600 });
    return true;
  });
}

async function recordError(home, error) {
  const line = `${new Date().toISOString()} ${error.stack || error.message}\n`;
  await writeFile(errorFile(home), line, { mode: 0o600 }).catch(() => {});
}

// Sessions registered between the last tick and exit must keep the watcher alive.
async function releaseIfIdle(store) {
  return store.locked(async state => {
    if (state.sessions.length) return false;
    await rm(pidFile(store.home), { force: true });
    return true;
  });
}

export async function runWatcher(service, { intervalMs = watchIntervalMs() } = {}) {
  const { store } = service;
  if (!await claim(store, intervalMs)) return;
  for (;;) {
    if (await readPid(store.home) !== process.pid) return; // Replaced, or the home was deleted.
    const beat = new Date();
    await utimes(pidFile(store.home), beat, beat);
    let remaining = 1;
    try { remaining = await service.reconcile(); }
    catch (error) { await recordError(store.home, error); }
    if (remaining === 0 && await releaseIfIdle(store)) return;
    await delay(intervalMs);
  }
}
