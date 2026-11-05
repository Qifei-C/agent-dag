import { randomUUID } from 'node:crypto';

export const SYSTEM_SENDER = 'dag';
const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_WATCH_SECONDS = 5;
const MAX_LISTED_IDS = 20;
// sending/uncertain may or may not have reached the pane; with the receiver gone
// nobody can confirm them. injected/submitted/acknowledged are not undelivered.
const UNDELIVERED = new Set(['queued', 'sending', 'uncertain']);

export function offlineTtlMs(env = process.env) {
  const value = env.DAG_OFFLINE_TTL;
  if (value === undefined) return DEFAULT_TTL_SECONDS * 1000;
  if (!/^\d+$/.test(value)) throw new Error('DAG_OFFLINE_TTL must be a whole number of seconds (0 removes immediately).');
  return Number(value) * 1000;
}

export function watchIntervalMs(env = process.env) {
  const value = env.DAG_WATCH_INTERVAL;
  if (value === undefined) return DEFAULT_WATCH_SECONDS * 1000;
  const seconds = Number(value);
  if (!value.trim() || !Number.isFinite(seconds) || seconds <= 0) throw new Error('DAG_WATCH_INTERVAL must be a positive number of seconds.');
  return seconds * 1000;
}

const stateOf = live => (live.online ? 'online' : live.offline ? 'offline' : 'unknown');

export function presenceOf(session, live, ttlMs) {
  const state = stateOf(live);
  if (state !== 'offline' || !session.offlineSince) return { state };
  return { state, since: session.offlineSince,
    removesAt: new Date(Date.parse(session.offlineSince) + ttlMs).toISOString() };
}

// The sessions whose work depends on this one: its parent and children, and
// peers whose latest exchange with it was a message it has not answered.
export function relatedSessions(state, session) {
  const lastSpoke = new Map();
  for (const message of state.messages) {
    if (message.to === session.id) lastSpoke.set(message.from, 'peer');
    else if (message.from === session.id) lastSpoke.set(message.to, 'session');
  }
  return state.sessions.filter(other => other.id !== session.id && (other.id === session.parentId
    || other.parentId === session.id || lastSpoke.get(other.id) === 'peer'));
}

export function orphanMessages(state, sessionIds, at) {
  const orphaned = state.messages.filter(m => sessionIds.has(m.to) && UNDELIVERED.has(m.status));
  for (const message of orphaned) {
    message.orphanedFrom = message.status;
    message.status = 'orphaned';
    message.orphanedAt = at;
    delete message.error;
  }
  return orphaned;
}

export function notice(recipient, event, about, text, at) {
  return { id: randomUUID(), from: SYSTEM_SENDER, fromName: SYSTEM_SENDER, to: recipient.id, toName: recipient.name,
    event, about: about.id, text, status: 'queued', createdAt: at };
}

export const offlineText = (session, removesAt) => `Session ${session.name} went offline. `
  + `Its record is removed at ${removesAt} unless it reconnects with: dag register ${session.name} --target PANE --replace. `
  + 'Until then new messages to it stay queued.';

export const onlineText = session => `Session ${session.name} is back online.`;

export function removedText(session, orphaned) {
  const ids = orphaned.slice(0, MAX_LISTED_IDS).map(m => m.id).join(', ');
  const more = orphaned.length > MAX_LISTED_IDS ? ` and ${orphaned.length - MAX_LISTED_IDS} more` : '';
  return `Session ${session.name} was removed from the registry.`
    + (orphaned.length ? ` ${orphaned.length} message(s) you sent were not confirmed delivered and are now orphaned: ${ids}${more}.` : '');
}
