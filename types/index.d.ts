export type AgentStatus =
  | 'pending' | 'running' | 'waiting' | 'idle'
  | 'completed' | 'failed' | 'killed'

export type View = 'tree' | 'cards'
export type GlyphSet = 'unicode' | 'ascii'

export type AgentNode = {
  id: string
  parentId?: string
  label: string
  type: string
  name?: string
  teammateId?: string
  isTeammate: boolean
  workflowRunId?: string
  model?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  turns: number
  inputTokens: number
  outputTokens: number
  toolCount: number
  currentTool?: string
  recentTools: string[]
}

export type MessageEdge = {
  from: string
  to: string
  count: number
  lastAt: number
  lastText: string
}

export type DagState = {
  nodes: Record<string, AgentNode>
  order: string[]
  messages: MessageEdge[]
  view: View
  showMessages: boolean
  showTools: boolean
  isClosedByPerson: boolean
  hasOpened: boolean
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    // Shaped: the atom carries a shape tag, so a reload whose code names a
    // new tag starts fresh instead of reading an old layout.
    'agent-dag': { dag: Shaped<DagState> }
  }
}
