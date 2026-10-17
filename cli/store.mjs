import { mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class Store {
  constructor(home = process.env.DAG_HOME || join(homedir(), '.local', 'state', 'agent-dag')) {
    this.home = resolve(home);
    this.file = join(this.home, 'state.json');
  }

  async read() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: [], messages: [] };
      throw error;
    }
    const state = JSON.parse(raw);
    if (state.version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.messages)) {
      throw new Error(`Unsupported registry format: ${this.file}`);
    }
    return state;
  }

  async save(state) {
    const temp = join(this.home, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state, null, 2) + '\n');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, this.file);
    } finally { await rm(temp, { force: true }); }
  }

  // Wait for registration/delivery transactions before exposing their result.
  async snapshot() { return this.locked(state => state); }

  // All mutations, including external tmux effects, share this local lock.
  // Dead owners are recovered; an interrupted transmission is never replayed.
  async locked(fn) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const lock = join(this.home, 'lock');
    const owner = `${process.pid}-${randomUUID()}`;
    const until = Date.now() + 15000;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const entries = await readdir(lock);
          const entry = entries[0];
          if (entry) {
            const pid = Number(entry.split('-')[0]);
            if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock owner in ${lock}`);
            try { process.kill(pid, 0); }
            catch (e) {
              if (e.code !== 'ESRCH') throw e;
              // Only the contender that removes this unique owner file may
              // remove the directory. Others retry without touching a new lock.
              await unlink(join(lock, entry));
              await rmdir(lock);
              continue;
            }
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (Date.now() > until) throw new Error(`Registry is busy (${lock}); try again shortly. An empty lock left by a killed process may be removed with rmdir.`);
        await delay(40);
      }
    }
    try {
      await (await open(join(lock, owner), 'wx', 0o600)).close();
      return await fn(await this.read());
    } finally {
      await rm(join(lock, owner), { force: true });
      await rmdir(lock);
    }
  }
}
