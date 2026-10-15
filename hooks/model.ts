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

export const children = (s: DagState, id: string): AgentNode[] =>
  s.order.map(k => s.nodes[k]).filter(n => n && n.id !== MAIN && (n.parentId ?? MAIN) === id)

export const resolveAddress = (s: DagState, to: string): string => {
  if (s.nodes[to]) return to
  const hit = s.order.map(k => s.nodes[k]).find(n => n.name === to || n.teammateId === to)
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

const placeholder = (id: string, at: number, parentId = MAIN, label = 'agent', type = 'agent'): AgentNode => ({
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

const patch = (s: DagState, id: string, fn: (n: AgentNode) => AgentNode): DagState => ({
  ...s, nodes: { ...s.nodes, [id]: fn(s.nodes[id]) },
})

const endStatus = (n: AgentNode, reason: 'answer' | 'aborted' | 'error' | 'refusal'): AgentStatus => {
  if (reason === 'aborted') return 'killed'
  if (reason === 'error' || reason === 'refusal') return 'failed'
  return n.id === MAIN || n.isTeammate ? 'idle' : 'completed'
}

export const apply = (s: DagState, ev: DagEvent): DagState => {
  switch (ev.kind) {
    case 'spawn': {
      const base = ensure(ensure(s, ev.parentId, ev.at), ev.agentId, ev.at, ev.parentId)
      return patch(base, ev.agentId, n => ({
        ...n, parentId: ev.parentId, label: ev.label, type: ev.type, isTeammate: ev.isTeammate,
        name: ev.name ?? n.name, teammateId: ev.teammateId ?? n.teammateId,
        workflowRunId: ev.workflowRunId ?? n.workflowRunId, model: ev.model ?? n.model,
        status: 'pending', startedAt: ev.at, endedAt: undefined, currentTool: undefined,
      }))
    }
    case 'turn-start': {
      const id = loopId(ev.agentId)
      return patch(ensure(s, id, ev.at), id, n => ({ ...n, status: 'running', turns: n.turns + 1, endedAt: undefined }))
    }
    case 'tool-start': {
      const id = loopId(ev.agentId)
      return patch(ensure(s, id, 0), id, n => ({ ...n, currentTool: ev.tool }))
    }
    case 'tool-end': {
      const id = loopId(ev.agentId)
      return patch(ensure(s, id, 0), id, n => ({
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
        inputTokens: n.inputTokens + (ev.usage?.input_tokens ?? 0),
        outputTokens: n.outputTokens + (ev.usage?.output_tokens ?? 0),
      }))
    }
    case 'message': {
      const to = resolveAddress(s, ev.to)
      const text = ev.text.replace(/\s+/g, ' ').trim().slice(0, LAST_TEXT)
      const i = s.messages.findIndex(m => m.from === ev.from && m.to === to)
      const edge: MessageEdge = i < 0
        ? { from: ev.from, to, count: 1, lastAt: ev.at, lastText: text }
        : { ...s.messages[i], count: s.messages[i].count + 1, lastAt: ev.at, lastText: text }
      const messages = i < 0 ? [...s.messages, edge] : s.messages.map((m, k) => (k === i ? edge : m))
      return { ...s, messages }
    }
    case 'reconcile': {
      let out = s
      for (const a of ev.agents) {
        out = ensure(out, a.id, ev.at, a.parentId ?? MAIN, a.description || a.name || a.type, a.type)
        out = patch(out, a.id, n => {
          const takes = a.status !== 'running' && a.status !== 'pending' && !ENDED.has(n.status)
          return {
            ...n,
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
