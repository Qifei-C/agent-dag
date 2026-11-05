#!/usr/bin/env node
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateReport } from './common.mjs';

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log('dag-report --file /path/report.json [--bootstrap]\nRequired JSON: agent, status, task, summary, validation:[{name,status,evidence?}]. Optional: blockers, dependsOn, evidence.\nAgent statuses: working, waiting, blocked, review, complete. Checks: pending, running, pass, fail, unknown, draft.');
  } else {
    const index = args.indexOf('--file');
    if (index < 0 || !args[index+1]) throw new Error('--file is required');
    const input = JSON.parse(await readFile(args[index+1], 'utf8'));
    if (JSON.stringify(input).length > 32000) throw new Error('Report exceeds 32 KB');
    validateReport(input);
    const report = {...input, source: args.includes('--bootstrap') ? 'deployment-observer' : 'agent-report', updatedAt: new Date().toISOString()};
    const dir = join(process.env.DAG_HOME || join(homedir(), '.local/state/agent-dag'), 'reports');
    await mkdir(dir, {recursive:true, mode:0o700});
    const target = join(dir, input.agent + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(report, null, 2) + '\n', {mode:0o600});
    await rename(temp, target);
    console.log('Reported ' + input.agent + ' at ' + report.updatedAt);
  }
} catch (error) { console.error(error.message); process.exitCode=1; }
