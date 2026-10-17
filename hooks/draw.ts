import type { AgentNode, AgentStatus, DagState, GlyphSet } from '../types'
import { MAIN, children, shortModel } from './model'
import { GLYPHS, STATUS_COLOR, STATUS_WORD, fit, fmtElapsed, fmtTokens, padLeft, textWidth, wrapText } from './format'

export type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Row = Segment[]
export type LayoutOptions = { columns: number; glyphs: GlyphSet; now: number }
export type Card = {
  id: string; depth: number; status: AgentStatus; rows: Row[]
  prefix: string; continuation: string; width: number
}

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
  // Keep room for detail fields even when the graph is very deeply nested.
  const gutterLimit = Math.max(0, Math.floor((o.columns - 26) / 2) * 2)
  const gutter = (prefix: string) => textWidth(prefix) <= gutterLimit ? prefix
    : gutterLimit >= 4 ? ell + ' ' + prefix.slice(-(gutterLimit - 2)) : ''
  return flatten([root]).map(it => {
    const prefix = gutter(connector(it, g))
    const continuation = gutter(it.depth === 0 ? ''
      : it.trail.slice(1).map(more => more ? g.pipe : g.blank).join('') + (it.isLast ? g.blank : g.pipe))
    const width = o.columns - textWidth(prefix)
    const inner = width - 4
    const n = it.node
    const title = wrapText(it.label, inner - 3, 3, ell)
    const rows: Row[] = [[statusSeg(it.status, g.status[it.status]), { text: ' ' + (title[0] ?? ''), bold: true }]]
    for (const line of title.slice(1)) rows.push([{ text: '  ' + line, bold: true }])
    // Pack whole fields onto successive lines instead of truncating the entire
    // metadata row, which used to hide token, turn and tool counts.
    const fields = (parts: string[]) => {
      let line = ''
      for (const part of parts) {
        const next = line ? line + dot + part : part
        if (line && textWidth(next) > inner) {
          rows.push([{ text: line, dim: true }])
          line = part
        } else line = next
      }
      if (line) rows.push(...wrapText(line, inner, 2, ell).map(text => [{ text, dim: true }]))
    }
    if (n) {
      fields([
        STATUS_WORD[n.status],
        shortModel(n.model) || '?',
        fmtElapsed(elapsedOf(n, o.now)),
        `${n.turns} turn${n.turns === 1 ? '' : 's'}`,
      ])
      fields([
        `tokens ${fmtTokens(n.inputTokens + n.outputTokens)}`,
        `in ${fmtTokens(n.inputTokens)}`, `out ${fmtTokens(n.outputTokens)}`,
        `${n.toolCount} tool${n.toolCount === 1 ? '' : 's'}`,
      ])
      if (s.showTools) {
        // The current tool has its own row and cannot be pushed off by history.
        if (n.currentTool) rows.push(...wrapText(`now ${g.chip} ${n.currentTool}`, inner, 2, ell)
          .map(text => [{ text, color: 'claude' }]))
        if (n.recentTools.length) rows.push(...wrapText(`recent ${n.recentTools.join(` ${g.arrow} `)}`, inner, 2, ell)
          .map(text => [{ text, dim: true }]))
      }
      if (s.showMessages) {
        const messages = s.messages.filter(m => m.from === n.id || m.to === n.id)
        if (messages.length) {
          const latest = messages.reduce((a, b) => a.lastAt >= b.lastAt ? a : b)
          const sent = messages.filter(m => m.from === n.id).reduce((sum, m) => sum + m.count, 0)
          const received = messages.filter(m => m.to === n.id).reduce((sum, m) => sum + m.count, 0)
          const outgoing = latest.from === n.id
          const peer = outgoing ? latest.to : latest.from
          fields([`msg ${sent} sent / ${received} received`])
          const direction = outgoing ? g.arrow : o.glyphs === 'ascii' ? '<-' : '←'
          const quote = `${direction} ${s.nodes[peer]?.label ?? peer}: "${latest.lastText}"`
          rows.push(...wrapText(quote, inner, 2, ell).map(text => [{ text, dim: true }]))
        }
      }
    } else if (it.members) {
      fields([
        `${it.members.length} agents`,
        `${it.members.filter(m => m.status === 'running').length} running`,
        `${it.members.filter(m => m.status === 'failed').length} failed`,
        `tokens ${fmtTokens(it.members.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0))}`,
      ])
    }
    return { id: it.id, depth: it.depth, status: it.status, rows, prefix, continuation, width }
  })
}

/** Bordered detail cards connected by the same branches as the compact tree. */
export const cardRows = (s: DagState, o: LayoutOptions): Row[] => {
  const ascii = o.glyphs === 'ascii'
  const b = ascii ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }
    : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  const out: Row[] = []
  for (const card of cards(s, o)) {
    const border = (text: string): Segment => statusSeg(card.status, text)
    const title = card.rows[0]!
    const titleWidth = textWidth(title.map(seg => seg.text).join(''))
    out.push([{ text: card.prefix, dim: true }, border(b.tl + b.h + ' '), ...title,
      border(' ' + b.h.repeat(Math.max(0, card.width - titleWidth - 5)) + b.tr)])
    for (const row of card.rows.slice(1)) {
      const size = textWidth(row.map(seg => seg.text).join(''))
      out.push([{ text: card.continuation, dim: true }, border(b.v + ' '), ...row,
        { text: ' '.repeat(Math.max(0, card.width - 4 - size)) }, border(' ' + b.v)])
    }
    out.push([{ text: card.continuation, dim: true }, border(b.bl + b.h.repeat(Math.max(0, card.width - 2)) + b.br)])
  }
  return out
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
