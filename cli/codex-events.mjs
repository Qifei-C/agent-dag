const toolName = item => ({
  commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch',
  collabAgentToolCall: item.tool || 'Agent', imageGeneration: 'ImageGen',
  mcpToolCall: `${item.server || 'mcp'}/${item.tool || 'tool'}`,
  dynamicToolCall: item.tool || 'Tool',
})[item.type];

export const CODEX_EVENTS = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed',
  'thread/tokenUsage/updated', 'item/started', 'item/completed', 'model/rerouted']);

export const runtimeStatus = status => {
  if (status?.type === 'active') return status.activeFlags?.length ? 'waiting' : 'running';
  if (status?.type === 'systemError') return 'failed';
  if (status?.type === 'notLoaded') return 'idle';
  return 'idle';
};

function nodeOf(thread, rootId, at) {
  return {
    id: thread.id, parentId: thread.parentThreadId || (thread.id === rootId ? undefined : rootId),
    label: thread.agentNickname || thread.name || thread.preview?.slice(0, 120) || 'Codex',
    type: thread.agentRole || 'codex', model: thread.model || undefined,
    status: runtimeStatus(thread.status), startedAt: thread.createdAt ? thread.createdAt * 1000 : at,
    turns: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, recentTools: [],
    turnIds: [], completedToolIds: [], activeTools: {},
  };
}

/** Thread-scoped reducer. Cumulative usage snapshots replace, never add. */
export function applyCodexEvent(previous, rootId, event, at = Date.now()) {
  if (!CODEX_EVENTS.has(event.method)) return previous;
  const out = structuredClone(previous || { rootId, nodes: {}, observedAt: at });
  const p = event.params || {};
  if (event.method === 'thread/started') {
    const thread = p.thread;
    if (!thread?.id || (thread.id !== rootId && !out.nodes[thread.parentThreadId])) return previous;
    const old = out.nodes[thread.id];
    out.nodes[thread.id] = old ? { ...old, model: thread.model || old.model,
      status: thread.id === rootId || !old.endedAt ? runtimeStatus(thread.status) : old.status } : nodeOf(thread, rootId, at);
  } else {
    const n = out.nodes[p.threadId];
    if (!n) return previous;
    switch (event.method) {
      case 'thread/status/changed':
        if (!(n.id !== rootId && ['completed', 'failed', 'killed'].includes(n.status) && p.status?.type === 'idle')) {
          n.status = runtimeStatus(p.status);
        }
        break;
      case 'turn/started':
        if (!n.turnIds.includes(p.turn.id)) { n.turnIds.push(p.turn.id); n.turns++; }
        n.status = 'running'; n.endedAt = undefined;
        break;
      case 'turn/completed':
        n.status = p.turn.status === 'failed' ? 'failed' : p.turn.status === 'interrupted' ? 'killed'
          : n.id === rootId ? 'idle' : 'completed';
        n.endedAt = p.turn.completedAt ? p.turn.completedAt * 1000 : at;
        n.activeTools = {}; n.currentTool = undefined;
        break;
      case 'thread/tokenUsage/updated': {
        const total = p.tokenUsage?.total;
        if (!total) return previous;
        // cachedInputTokens and reasoningOutputTokens are breakdowns, not
        // additional billable input/output to add a second time.
        n.inputTokens = total.inputTokens;
        n.outputTokens = total.outputTokens;
        n.cachedInputTokens = total.cachedInputTokens;
        n.reasoningOutputTokens = total.reasoningOutputTokens;
        break;
      }
      case 'item/started': case 'item/completed': {
        const name = p.item && toolName(p.item);
        if (!name) return previous;
        if (event.method === 'item/started' && !n.completedToolIds.includes(p.item.id)) {
          n.activeTools[p.item.id] = name;
        } else if (event.method === 'item/completed') {
          delete n.activeTools[p.item.id];
          if (!n.completedToolIds.includes(p.item.id)) {
            n.completedToolIds.push(p.item.id); n.toolCount++;
            n.recentTools = [...n.recentTools, name].slice(-6);
          }
        }
        n.currentTool = Object.values(n.activeTools).at(-1);
        break;
      }
      case 'model/rerouted': n.model = p.toModel || n.model; break;
      default: return previous;
    }
  }
  out.observedAt = at;
  delete out.error;
  return out;
}
