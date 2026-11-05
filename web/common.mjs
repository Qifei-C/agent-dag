import { resolve, sep } from 'node:path';

// Reports are stored as <agent>.json, so the name must be safe in a path.
const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function agentAllowed(name, env = process.env) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return false;
  const listed = env.DAG_WEB_AGENTS?.split(',').map(s => s.trim()).filter(Boolean);
  return !listed?.length || listed.includes(name);
}
export function redact(value) {
  return String(value)
    .replace(/hf_[A-Za-z0-9]{15,}/g, '[HF TOKEN REDACTED]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[AWS KEY REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{15,}/g, '[API KEY REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/((?:aws_secret_access_key|aws_session_token|access_token|refresh_token|password|api_key|HF_TOKEN)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function redactTree(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactTree);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k, /^(?:access_token|refresh_token|password|api_key|aws_secret_access_key|aws_session_token|hf_token)$/i.test(k)?'[REDACTED]':redactTree(v)]));
  return value;
}
export function allowedFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\')) return null;
  if (!/^(reports\/(agents|handoffs|reviews)\/|dashboard\/)/.test(relative) && relative !== 'research-state.yaml') return null;
  if (relative.split('/').some(p => p === '..' || p.startsWith('.'))) return null;
  if (relative.split('/').some(p => ['deps', 'node_modules', 'remote'].includes(p))) return null;
  if (!/\.(md|txt|json|yaml|yml|html|csv)$/.test(relative)) return null;
  const path = resolve(root, relative);
  return path.startsWith(resolve(root) + sep) ? path : null;
}
export function activity(text, online, changedAt) {
  if (!online) return {state: 'offline', label: '会话离线'};
  const tail = text.split('\n').slice(-18).join('\n');
  if (/esc to interrupt|ctrl\+c to interrupt|[✽✶✻✢✳].*….*(?:thinking|tokens|effort)|Working \(/i.test(tail))
    return {state: 'active', label: '正在工作 · 终端推断'};
  if (/approval required|Allow once|Trust and continue|Do you trust/i.test(tail))
    return {state: 'blocked', label: '等待确认 · 终端推断'};
  if (/Ask Codex to do anything|[❯›]\s*\n/.test(tail))
    return {state: 'idle', label: '输入提示 · 可能有后台任务'};
  if (changedAt && Date.now() - Date.parse(changedAt) < 15000)
    return {state: 'active', label: '终端有更新'};
  return {state: 'unknown', label: '终端暂未更新'};
}
export function validateReport(report, env = process.env) {
  if (!agentAllowed(report.agent, env)) throw new Error('Unknown agent');
  if (!['working','waiting','blocked','review','complete'].includes(report.status)) throw new Error('Invalid status');
  for (const key of ['task', 'summary']) if (typeof report[key] !== 'string' || report[key].length > 4000) throw new Error('Expected short ' + key);
  if (!Array.isArray(report.validation) || report.validation.length > 20) throw new Error('validation must be an array (max 20)');
  for (const check of report.validation) {
    if (!check.name || !['pending','running','pass','fail','unknown','draft'].includes(check.status)) throw new Error('Invalid validation check');
  }
  if (report.dependsOn && (!Array.isArray(report.dependsOn) || report.dependsOn.some(x => !agentAllowed(x, env) || x === report.agent))) throw new Error('Invalid dependsOn');
  for (const key of ['blockers','evidence']) if (report[key] && (!Array.isArray(report[key]) || report[key].length > 30 || report[key].some(x => typeof x !== 'string' || x.length > 2000))) throw new Error('Invalid ' + key);
  return report;
}
