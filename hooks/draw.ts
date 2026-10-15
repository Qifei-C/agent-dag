import type { AgentNode, AgentStatus, DagState, GlyphSet } from '../types'
import { MAIN, children, shortModel } from './model'
import { GLYPHS, STATUS_COLOR, STATUS_WORD, fit, fmtElapsed, fmtTokens, padLeft } from './format'

export type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Row = Segment[]
export type LayoutOptions = { columns: number; glyphs: GlyphSet; now: number }
export type Card = { depth: number; status: AgentStatus; rows: Row[] }

const MIN_LABEL = 12
const MAX_MESSAGES = 12
const NAME_WIDTH = 18
const BARE_TYPES = new Set(['general-purpose', 'teammate', 'claude', 'session', 'agent'])

export const visibleColumns = (width: number) => ({
  status: width >= 40,
  tokens: width >= 48,
  model: width >= 60,
  tool: width >= 72,
})

const elapsedOf = (n: AgentNode, now: number): number =>
  (n.status === 'running' || n.status === 'pending' || n.endedAt === undefined ? now : n.endedAt) - n.startedAt

const labelOf = (n: AgentNode): string =>
  BARE_TYPES.has(n.type) || n.label === n.type ? n.label : `${n.type}: ${n.label}`

const ellipsisOf = (glyphs: GlyphSet) => (glyphs === 'ascii' ? '~' : '…')

/** A drawable item: a node, or a synthetic workflow group. */
type Item = {
  id: string
  label: string
  status: AgentStatus
  node?: AgentNode
  depth: number
  isLast: boolean
  trail: boolean[]   // for each ancestor depth, whether a pipe continues
  kids: Item[]
  members?: AgentNode[]   // set on a workflow group item
}

const groupStatus = (nodes: AgentNode[]): AgentStatus => {
  if (nodes.some(n => n.status === 'running')) return 'running'
  if (nodes.some(n => n.status === 'failed')) return 'failed'
  if (nodes.some(n => n.status === 'pending' || n.status === 'waiting')) return 'pending'
  if (nodes.every(n => n.status === 'completed' || n.status === 'killed')) return 'completed'
  return 'idle'
}

/** Children of `id` as items, with workflow agents folded into group items. */
const itemsUnder = (s: DagState, id: string, depth: number, trail: boolean[]): Item[] => {
  const kids = children(s, id)
  const out: Item[] = []
  const seenRuns = new Set<string>()
  for (const k of kids) {
    if (k.workflowRunId) {
      if (seenRuns.has(k.workflowRunId)) continue
      seenRuns.add(k.workflowRunId)
      const members = kids.filter(m => m.workflowRunId === k.workflowRunId)
      out.push({ id: `wf:${k.workflowRunId}`, label: `workflow ${k.workflowRunId}`, status: groupStatus(members),
        depth, isLast: false, trail, kids: [], members })
    } else {
      out.push({ id: k.id, label: labelOf(k), status: k.status, node: k, depth, isLast: false, trail, kids: [] })
    }
  }
  out.forEach((it, i) => {
    it.isLast = i === out.length - 1
    const nextTrail = [...trail, !it.isLast]
    const members = it.members
    it.kids = members
      ? members.map((m, j) => ({ id: m.id, label: labelOf(m), status: m.status, node: m, depth: depth + 1,
          isLast: j === members.length - 1, trail: nextTrail,
          kids: itemsUnder(s, m.id, depth + 2, [...nextTrail, j !== members.length - 1]) }))
      : itemsUnder(s, it.id, depth + 1, nextTrail)
  })
  return out
}

const flatten = (items: Item[]): Item[] => items.flatMap(it => [it, ...flatten(it.kids)])

/** The main loop's item with the whole tree beneath it. */
const rootItem = (s: DagState): Item => {
  const main = s.nodes[MAIN]
  const root: Item = { id: MAIN, label: 'main', status: main?.status ?? 'idle', node: main, depth: 0, isLast: true, trail: [], kids: [] }
  root.kids = itemsUnder(s, MAIN, 1, [true])
  return root
}

const connector = (it: Item, g: typeof GLYPHS.unicode): string => {
  if (it.depth === 0) return ''
  const lead = it.trail.slice(1).map(more => (more ? g.pipe : g.blank)).join('')
  return lead + (it.isLast ? g.elbow : g.tee)
}

const statusSeg = (st: AgentStatus, text: string): Segment => ({ text, ...STATUS_COLOR[st] })

export const treeRows = (s: DagState, o: LayoutOptions): Row[] => {
  const g = GLYPHS[o.glyphs]
  const root = rootItem(s)
  const items = flatten([root])
  const cols = visibleColumns(o.columns)
  const ell = ellipsisOf(o.glyphs)

  // Fixed widths of the right-hand columns (including their leading space).
  const wStatus = cols.status ? 8 : 0   // ' running'
  const wElapsed = 7                    // ' 1h03m ' style, right aligned in 6 + space
  const wTokens = cols.tokens ? 7 : 0   // ' 12.4k'
  const wModel = cols.model ? 8 : 0     // ' sonnet '
  const wTool = cols.tool ? 10 : 0      // ' ToolSearc'
  const right = wStatus + wElapsed + wTokens + wModel + wTool

  return items.map(it => {
    const conn = connector(it, g)
    const glyph = g.status[it.status]
    const head = [...conn].length + [...glyph].length + 1
    const labelWidth = Math.max(MIN_LABEL, o.columns - head - right)
    const room = o.columns - head - labelWidth  // what is left for the right columns
    const n = it.node
    const row: Row = [
      { text: conn, dim: true },
      statusSeg(it.status, glyph),
      { text: ' ' + fit(it.label, labelWidth, ell), bold: it.depth === 0 },
    ]
    let used = 0
    const push = (w: number, text: string, extra: Partial<Segment> = {}) => {
      if (w === 0 || used + w > room) return
      used += w
      row.push({ text: padLeft(text, w), ...extra })
    }
    if (cols.status) push(wStatus, STATUS_WORD[it.status], STATUS_COLOR[it.status])
    push(wElapsed, n ? fmtElapsed(elapsedOf(n, o.now)) : '', { dim: true })
    if (cols.tokens) push(wTokens, n ? fmtTokens(n.inputTokens + n.outputTokens) : '', { dim: true })
    if (cols.model) push(wModel, n ? shortModel(n.model) : '', { dim: true })
    if (cols.tool) push(wTool, n?.currentTool ? fit(n.currentTool, wTool - 1, ell).trimEnd() : '', { color: 'claude' })
    return row
  })
}

export const cards = (s: DagState, o: LayoutOptions): Card[] => {
  const g = GLYPHS[o.glyphs]
  const dot = o.glyphs === 'ascii' ? ' - ' : ' · '
  const ell = ellipsisOf(o.glyphs)
  const root = rootItem(s)
  return flatten([root]).map(it => {
    const inner = o.columns - 4 - 2 * it.depth
    const n = it.node
    const rows: Row[] = [[statusSeg(it.status, g.status[it.status]), { text: ' ' + fit(it.label, inner - 2, ell).trimEnd(), bold: true }]]
    if (n) {
      const meta = [
        `${STATUS_WORD[n.status]} ${fmtElapsed(elapsedOf(n, o.now))}`,
        shortModel(n.model) || '?',
        fmtTokens(n.inputTokens + n.outputTokens),
        `${n.turns} turn${n.turns === 1 ? '' : 's'}`,
      ].join(dot)
      rows.push([{ text: fit(meta, inner, ell).trimEnd(), dim: true }])
      if (s.showTools) {
        const chips: Row = []
        if (n.recentTools.length) chips.push({ text: n.recentTools.join(' '), dim: true })
        if (n.currentTool) chips.push({ text: `${chips.length ? ' ' : ''}${g.chip} ${n.currentTool}`, color: 'claude' })
        if (!chips.length) chips.push({ text: 'no tools yet', dim: true })
        const total = chips.map(c => c.text).join('')
        if ([...total].length > inner) {
          rows.push([{ text: fit(total, inner, ell), dim: true }])
        } else rows.push(chips)
      }
    }
    return { depth: it.depth, status: it.status, rows }
  })
}

export const messageRows = (s: DagState, o: LayoutOptions): Row[] => {
  if (!s.showMessages || s.messages.length === 0) return []
  const g = GLYPHS[o.glyphs]
  const ell = ellipsisOf(o.glyphs)
  // Bare labels (no type prefix) so a sender and a receiver read as names.
  const nameOf = (id: string) => fit(s.nodes[id]?.label ?? id, NAME_WIDTH, ell).trimEnd()
  const hasQuote = o.columns >= 60
  // Two names, an arrow and spaces at most; narrower when the pane is.
  const pairWidth = Math.max(10, Math.min(2 * NAME_WIDTH + 5, o.columns - 4 - (hasQuote ? 20 : 0)))
  const rows: Row[] = [[{ text: 'messages', dim: true, bold: true }]]
  const sorted = [...s.messages].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_MESSAGES)
  for (const m of sorted) {
    const pair = `  ${nameOf(m.from)} ${g.arrow} ${nameOf(m.to)}`
    const row: Row = [{ text: fit(pair, pairWidth, ell) }, { text: padLeft(String(m.count), 4), dim: true }]
    if (hasQuote) {
      const room = o.columns - pairWidth - 4 - 3   // space, two quotes
      if (room > 3) row.push({ text: ` "${fit(m.lastText, room, ell).trimEnd()}"`, dim: true })
    }
    rows.push(row)
  }
  return rows
}

export const summary = (s: DagState, glyphs: GlyphSet): string => {
  const agents = s.order.filter(id => id !== MAIN)
  const running = agents.filter(id => s.nodes[id]?.status === 'running').length
  const sep = glyphs === 'ascii' ? ' - ' : ' · '
  return `${agents.length} agent${agents.length === 1 ? '' : 's'}${sep}${running} running`
}

export const plainText = (rows: Row[]): string =>
  rows.map(r => r.map(seg => seg.text).join('').trimEnd()).join('\n')
