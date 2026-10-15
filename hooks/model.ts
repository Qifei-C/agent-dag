import type { AgentNode, AgentStatus, DagState, MessageEdge, View } from '../types'

export const MAIN = 'main'
const RECENT_TOOLS = 6
const LAST_TEXT = 60
const ENDED: ReadonlySet<AgentStatus> = new Set(['completed', 'failed', 'killed'])

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type ListedAgent = {
  id: string
  status: AgentStatus
  name?: string
  teammateId?: string
  description?: string
  type?: string
  parentId?: string
}

export type DagEvent =
  | { kind: 'spawn'; agentId: string; parentId: string; label: string; type: string;
      isTeammate: boolean; name?: string; teammateId?: string; workflowRunId?: string;
      model?: string; at: number }
  | { kind: 'turn-start'; agentId: string | undefined; at: number }
  | { kind: 'tool-start'; agentId: string | undefined; tool: string }
  | { kind: 'tool-end'; agentId: string | undefined; tool: string }
  | { kind: 'turn-end'; agentId: string | undefined; reason: 'answer' | 'aborted' | 'error' | 'refusal';
      usage?: Usage; at: number }
  | { kind: 'message'; from: string; to: string; text: string; at: number }
  | { kind: 'reconcile'; agents: ListedAgent[]; at: number }
  | { kind: 'tick'; at: number }
  | { kind: 'reset'; at: number }
  | { kind: 'set-flags'; view?: View; showMessages?: boolean; showTools?: boolean;
      isClosedByPerson?: boolean; hasOpened?: boolean }

export const loopId = (agentId: string | undefined): string => agentId ?? MAIN

const mainNode = (at: number): AgentNode => ({
  id: MAIN, label: 'main', type: 'session', isTeammate: false, status: 'idle',
  startedAt: at, turns: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, recentTools: [],
})

export const freshState = (now: number, view: View): DagState => ({
  nodes: { [MAIN]: mainNode(now) },
  order: [MAIN],
  messages: [],
  view,
  showMessages: true,
  showTools: true,
  isClosedByPerson: false,
  hasOpened: false,
  tick: 0,
})

export const isActive = (s: DagState): boolean =>
  Object.values(s.nodes).some(n => n.status === 'running' || n.status === 'pending')

const nodesInOrder = (s: DagState): AgentNode[] =>
  s.order.flatMap(k => (s.nodes[k] ? [s.nodes[k] as AgentNode] : []))

export const children = (s: DagState, id: string): AgentNode[] =>
  nodesInOrder(s).filter(n => n.id !== MAIN && (n.parentId ?? MAIN) === id)

export const resolveAddress = (s: DagState, to: string): string => {
  if (s.nodes[to]) return to
  const hit = nodesInOrder(s).find(n => n.name === to || n.teammateId === to)
  return hit ? hit.id : to
}

export const shortModel = (id: string | undefined): string => {
  if (!id) return ''
  for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (id.includes(family)) return family
  }
  const last = id.split('/').pop() ?? id
  return last.slice(0, 8)
}

/** The type of a node created before its spawn was seen; reconcile fills it in. */
const PLACEHOLDER_TYPE = 'agent'

const placeholder = (id: string, at: number, parentId = MAIN, label = 'agent', type = PLACEHOLDER_TYPE): AgentNode => ({
  id, parentId, label, type, isTeammate: false, status: 'pending', startedAt: at,
  turns: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, recentTools: [],
})

/** Returns state with `id` present (created as a placeholder when absent). */
const ensure = (s: DagState, id: string, at: number, parentId = MAIN, label?: string, type?: string): DagState => {
  if (s.nodes[id]) return s
  const withParent = parentId === MAIN || s.nodes[parentId] ? s : ensure(s, parentId, at)
  return {
    ...withParent,
    nodes: { ...withParent.nodes, [id]: placeholder(id, at, parentId, label, type) },
    order: [...withParent.order, id],
  }
}

const patch = (s: DagState, id: string, fn: (n: AgentNode) => AgentNode): DagState => {
  const n = s.nodes[id]
  return n ? { ...s, nodes: { ...s.nodes, [id]: fn(n) } } : s
}

const endStatus = (n: AgentNode, reason: 'answer' | 'aborted' | 'error' | 'refusal'): AgentStatus => {
  if (reason === 'aborted') return 'killed'
  if (reason === 'error' || reason === 'refusal') return 'failed'
  return n.id === MAIN || n.isTeammate ? 'idle' : 'completed'
}

export const apply = (s: DagState, ev: DagEvent): DagState => {
  switch (ev.kind) {
    case 'spawn': {
      const base = ensure(ensure(s, ev.parentId, ev.at), ev.agentId, ev.at, ev.parentId)
      return patch(base, ev.agentId, n => {
        // The spawn's bookkeeping can land after the agent's first turn.start:
        // a loop already running keeps its status, tool, clock and turn count.
        const isLive = n.status === 'running' || n.status === 'waiting'
        return {
          ...n, parentId: ev.parentId, label: ev.label, type: ev.type, isTeammate: ev.isTeammate,
          name: ev.name ?? n.name, teammateId: ev.teammateId ?? n.teammateId,
          workflowRunId: ev.workflowRunId ?? n.workflowRunId, model: ev.model ?? n.model,
          status: isLive ? n.status : 'pending',
          startedAt: isLive ? n.startedAt : ev.at,
          endedAt: undefined,
          currentTool: isLive ? n.currentTool : undefined,
        }
      })
    }
    case 'turn-start': {
      const id = loopId(ev.agentId)
      return patch(ensure(s, id, ev.at), id, n => ({ ...n, status: 'running', turns: n.turns + 1, endedAt: undefined }))
    }
    // Tool events never create a node: the engine's own forks (compaction,
    // memory) carry agent ids no list names and would become phantom rows.
    case 'tool-start':
      return patch(s, loopId(ev.agentId), n => ({ ...n, currentTool: ev.tool }))
    case 'tool-end': {
      const id = loopId(ev.agentId)
      return patch(s, id, n => ({
        ...n,
        toolCount: n.toolCount + 1,
        recentTools: [...n.recentTools, ev.tool].slice(-RECENT_TOOLS),
        currentTool: n.currentTool === ev.tool ? undefined : n.currentTool,
      }))
    }
    case 'turn-end': {
      const id = loopId(ev.agentId)
      return patch(ensure(s, id, ev.at), id, n => ({
        ...n,
        status: endStatus(n, ev.reason),
        endedAt: ev.at,
        currentTool: undefined,
        // input_tokens alone is only the uncached part of the prompt.
        inputTokens: n.inputTokens
          + (ev.usage?.input_tokens ?? 0)
          + (ev.usage?.cache_read_input_tokens ?? 0)
          + (ev.usage?.cache_creation_input_tokens ?? 0),
        outputTokens: n.outputTokens + (ev.usage?.output_tokens ?? 0),
      }))
    }
    case 'message': {
      const to = resolveAddress(s, ev.to)
      const text = ev.text.replace(/\s+/g, ' ').trim().slice(0, LAST_TEXT)
      const i = s.messages.findIndex(m => m.from === ev.from && m.to === to)
      const prev = i < 0 ? undefined : s.messages[i]
      const edge: MessageEdge = prev
        ? { ...prev, count: prev.count + 1, lastAt: ev.at, lastText: text }
        : { from: ev.from, to, count: 1, lastAt: ev.at, lastText: text }
      const messages = prev ? s.messages.map((m, k) => (k === i ? edge : m)) : [...s.messages, edge]
      return { ...s, messages }
    }
    case 'reconcile': {
      let out = s
      for (const a of ev.agents) {
        // The engine keeps finished agents listed for a while: never create a
        // node for one (a /dag reset or /clear would be undone), only update.
        if (!out.nodes[a.id] && ENDED.has(a.status)) continue
        out = ensure(out, a.id, ev.at, a.parentId ?? MAIN, a.description || a.name || a.type, a.type)
        out = patch(out, a.id, n => {
          const isPlaceholder = n.type === PLACEHOLDER_TYPE
          const settles = a.status !== 'running' && a.status !== 'pending' && !ENDED.has(n.status)
          const wakes = a.status === 'running' && (n.status === 'pending' || n.status === 'waiting')
          const takes = settles || wakes
          return {
            ...n,
            label: isPlaceholder ? a.description || a.name || a.type || n.label : n.label,
            type: isPlaceholder && a.type ? a.type : n.type,
            parentId: isPlaceholder && a.parentId ? a.parentId : n.parentId,
            name: n.name ?? a.name,
            teammateId: n.teammateId ?? a.teammateId,
            status: takes ? a.status : n.status,
            endedAt: takes && ENDED.has(a.status) ? ev.at : n.endedAt,
          }
        })
      }
      return out
    }
    case 'tick':
      return { ...s, tick: s.tick + 1 }
    case 'reset':
      return { ...freshState(ev.at, s.view), showMessages: s.showMessages, showTools: s.showTools,
        isClosedByPerson: s.isClosedByPerson, hasOpened: s.hasOpened }
    case 'set-flags': {
      const { kind: _k, ...flags } = ev
      const defined = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined))
      return { ...s, ...defined }
    }
  }
}
