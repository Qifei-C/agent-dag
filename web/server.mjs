import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Service } from '../cli/service.mjs';
import { Store } from '../cli/store.mjs';
import { agentAllowed, redact, redactTree, allowedFile, activity } from './common.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.RESEARCH_ROOT) throw new Error('Set RESEARCH_ROOT to the project directory the dashboard should read.');
const root = await realpath(process.env.RESEARCH_ROOT);
const projectName = process.env.DAG_WEB_PROJECT || basename(root);
const host = process.env.DAG_WEB_HOST || '127.0.0.1';
const port = Number(process.env.DAG_WEB_PORT || 8766);
const home = process.env.DAG_HOME || join(homedir(), '.local/state/agent-dag');
const store = new Store(home);
const service = new Service({store});
const hosts = new Set([host, 'localhost', '127.0.0.1', ...(process.env.DAG_WEB_ALLOWED_HOSTS || '').split(',')]);
let cache = null, collecting = false;
const seen = new Map();
const json = value => JSON.stringify(value);
const now = () => new Date().toISOString();
async function collect() {
  if (collecting) return;
  collecting = true;
  try {
    const errors = [];
    let project = {research:{}, artifacts:{}};
    const sessions = (await service.sessions()).filter(s => agentAllowed(s.name));
    try {
      const p = await exec('/usr/bin/python3', [join(here,'snapshot.py'), root, ...sessions.map(s => s.name)], {timeout:8000, maxBuffer:2000000});
      project = JSON.parse(p.stdout); errors.push(...(project.errors || []));
    } catch (e) { errors.push('Research metadata: ' + e.message); }
    const registry = await store.snapshot();
    const agents = await Promise.all(sessions.map(async session => {
      let terminal = '', error = null, report = null;
      if (session.online) try {
        const captured = await exec('tmux', ['-S',session.socket,'capture-pane','-p','-J','-t',session.pane,'-S','-65'], {timeout:3000, maxBuffer:180000});
        terminal = redact(captured.stdout.slice(-24000));
      } catch (e) { error = e.message; }
      const hash = createHash('sha256').update(terminal).digest('hex');
      const previous = seen.get(session.name);
      const changedAt = previous ? previous.hash === hash ? previous.changedAt : now() : null;
      seen.set(session.name, {hash, changedAt});
      try { report = redactTree(JSON.parse(await readFile(join(home,'reports',session.name+'.json'),'utf8'))); }
      catch (e) { if (e.code !== 'ENOENT') errors.push(session.name + ': report unavailable'); }
      return {...session, terminal, captureError:error, activity:activity(terminal, session.online && !error, changedAt), changedAt,
        report, artifacts:project.artifacts?.[session.name] || []};
    }));
    const idNames = Object.fromEntries(sessions.map(s=>[s.id,s.name]));
    cache = redactTree({observedAt:now(), pollSeconds:5, project:projectName,
      research:project.research, researchUpdatedAt:project.researchUpdatedAt,
      agents, messages:registry.messages.slice(-40).reverse().map(m=>({...m, fromName:idNames[m.from] || idNames[m.fromId] || idNames[m.senderId] || m.from || 'observer', toName:idNames[m.to] || idNames[m.toId] || idNames[m.receiverId] || m.to || '?'})), errors});
  } catch (e) {
    cache = {...(cache || {agents:[],messages:[],research:{}}), collectionError:redact(e.message)};
  } finally { collecting=false; }
}
const staticFiles = {'/':['index.html','text/html'], '/app.js':['app.js','application/javascript'], '/style.css':['style.css','text/css']};
const server = http.createServer(async (req,res)=>{
  const hostname = (req.headers.host || '').split(':')[0];
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (!hosts.has(hostname)) { res.writeHead(403); return res.end('Host not allowed'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Read-only dashboard'); }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state' || url.pathname === '/healthz') {
      const good = cache?.observedAt && Date.now()-Date.parse(cache.observedAt)<30000 && !cache.collectionError;
      res.writeHead(url.pathname==='/healthz' && !good ? 503 : 200, {'Content-Type':'application/json; charset=utf-8'});
      return res.end(req.method==='HEAD' ? '' : json(url.pathname==='/healthz' ? {ok:!!good, observedAt:cache?.observedAt, agents:cache?.agents.length} : cache));
    }
    if (url.pathname === '/api/file') {
      const relative = url.searchParams.get('path');
      const candidate = allowedFile(root,relative);
      if (!candidate) { res.writeHead(403); return res.end('File is outside permitted evidence paths'); }
      const actual = await realpath(candidate);
      if (!actual.startsWith(root+sep) || !allowedFile(root,actual.slice(root.length+1))) { res.writeHead(403); return res.end('Symlink target denied'); }
      if ((await stat(actual)).size > 1500000) { res.writeHead(413); return res.end('Evidence too large for inline viewing'); }
      const content = redact(await readFile(actual,'utf8'));
      res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end(req.method==='HEAD'?'':content);
    }
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); return res.end('Not found'); }
    const data = await readFile(join(here,file[0]));
    res.writeHead(200, {'Content-Type':file[1]+'; charset=utf-8'});
    res.end(req.method==='HEAD'?'':data);
  } catch (e) { res.writeHead(e.code==='ENOENT'?404:500); res.end(e.code==='ENOENT'?'Evidence not found':'Unable to read evidence'); }
});
await collect();
setInterval(collect,5000).unref();
server.listen(port,host,()=>console.log(`agent-dag browser listening on http://${host}:${port}`));
