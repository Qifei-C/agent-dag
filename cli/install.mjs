import { mkdir, lstat, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(process.argv[2] || join(homedir(), '.local', 'bin'));
const target = fileURLToPath(new URL('../bin/dag', import.meta.url));
const destination = join(dir, 'dag');
try {
  await mkdir(dir, { recursive: true });
  let existing;
  try { existing = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isSymbolicLink() || await realpath(destination).catch(() => '') !== await realpath(target)) {
      throw new Error(`${destination} already exists; it has not been replaced.`);
    }
  } else { await symlink(target, destination); }
  console.log(`Installed ${destination} -> ${target}`);
  if (!(process.env.PATH || '').split(delimiter).includes(dir)) {
    console.log(`Add ${JSON.stringify(dir)} to PATH. Sessions created by dag already inherit its executable directory.`);
  }
} catch (error) {
  console.error(`dag install: ${error.message}`);
  process.exitCode = 1;
}
