// Availability gates new delivery independently of readiness and runtime activity.
export const availabilityOf = session => session.availability || { state: 'available' };
export const isAvailable = session => availabilityOf(session).state === 'available';

export function setLimit(session, limit, source, at = new Date().toISOString()) {
  if (!limit || (session.availability?.source === 'manual' && !isAvailable(session))) return false;
  const previous = session.availability;
  if (previous?.source === source && previous.code === limit.code && previous.state === limit.state
      && previous.reason === limit.reason && previous.retryAt === limit.retryAt) return false;
  session.availability = { ...limit, source, since: at };
  session.updatedAt = at;
  return true;
}

export function codexLimit(error) {
  const code = error?.codexErrorInfo;
  const state = code === 'rateLimitExceeded' ? 'cooldown'
    : ['usageLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded'].includes(code) ? 'blocked' : undefined;
  return state ? { state, code, reason: error.message || code } : undefined;
}

export function codexEventLimit(event, rootId) {
  if (event.params?.threadId !== rootId) return;
  if (event.method === 'error') return codexLimit(event.params.error);
  if (event.method === 'turn/completed' && event.params.turn?.status === 'failed') {
    return codexLimit(event.params.turn.error);
  }
}

export function claudeLimit(event) {
  if (event.agent_id || event.parent_tool_use_id) return;
  if (event.hook_event_name === 'StopFailure') {
    const code = event.error;
    const state = code === 'rate_limit' ? 'cooldown'
      : ['billing_error', 'authentication_failed', 'account_on_hold', 'oauth_org_not_allowed'].includes(code) ? 'blocked' : undefined;
    return state ? { state, code, reason: event.error_details || event.last_assistant_message || code } : undefined;
  }
  if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
    const info = event.rate_limit_info;
    const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : undefined;
    return { state: 'cooldown', code: 'rate_limit', reason: 'Claude usage limit reached.',
      ...(reset && Number.isFinite(reset.getTime()) ? { retryAt: reset.toISOString() } : {}) };
  }
}
