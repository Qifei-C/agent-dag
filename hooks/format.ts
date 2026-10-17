import type { AgentStatus, GlyphSet } from '../types'

export type Glyphs = {
  status: Record<AgentStatus, string>
  tee: string
  elbow: string
  pipe: string
  blank: string
  arrow: string
  chip: string
  group: string
}

export const GLYPHS: Record<GlyphSet, Glyphs> = {
  unicode: {
    status: { pending: '◌', running: '◐', waiting: '○', idle: '●', completed: '✓', failed: '✗', killed: '⊘' },
    tee: '├─', elbow: '└─', pipe: '│ ', blank: '  ', arrow: '→', chip: '▸', group: '▸',
  },
  ascii: {
    status: { pending: '.', running: '>', waiting: 'o', idle: '*', completed: '+', failed: 'x', killed: '-' },
    tee: '|-', elbow: '`-', pipe: '| ', blank: '  ', arrow: '->', chip: '>', group: '>',
  },
}

export const STATUS_WORD: Record<AgentStatus, string> = {
  pending: 'pending', running: 'running', waiting: 'waiting', idle: 'idle',
  completed: 'done', failed: 'failed', killed: 'killed',
}

export const STATUS_COLOR: Record<AgentStatus, { color: string; dim?: boolean }> = {
  pending: { color: 'subtle' },
  running: { color: 'claude' },
  waiting: { color: 'warning' },
  idle: { color: 'subtle', dim: true },
  completed: { color: 'success' },
  failed: { color: 'error' },
  killed: { color: 'error', dim: true },
}

export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

export const fmtTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), s => s.segment)

const cellWidth = (text: string): number => {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(text)) return 0
  if (text.includes('\ufe0f') || /\p{Regional_Indicator}/u.test(text)) return 2
  return [...text].some(ch => {
    const cp = ch.codePointAt(0)!
    return cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
    )
  }) ? 2 : 1
}

/** Terminal cells, keeping combining accents and joined emoji together. */
export const textWidth = (text: string): number => graphemes(text).reduce((n, ch) => n + cellWidth(ch), 0)

const takeCells = (text: string, width: number): string => {
  let out = '', used = 0
  for (const ch of graphemes(text)) {
    const size = cellWidth(ch)
    if (used + size > width) break
    out += ch
    used += size
  }
  return out
}

export const fit = (text: string, width: number, ellipsis = '…'): string => {
  if (width <= 0) return ''
  const size = textWidth(text)
  if (size <= width) return text + ' '.repeat(width - size)
  const clipped = takeCells(text, Math.max(0, width - textWidth(ellipsis))) + ellipsis
  return clipped + ' '.repeat(Math.max(0, width - textWidth(clipped)))
}

export const padLeft = (text: string, width: number): string =>
  textWidth(text) >= width ? text : ' '.repeat(width - textWidth(text)) + text

/** Word-wrap short detail fields; only the final permitted line is truncated. */
export const wrapText = (text: string, width: number, maxLines = 2, ellipsis = '…'): string[] => {
  let rest = text.replace(/\s+/g, ' ').trim()
  if (width <= 0 || !rest || maxLines <= 0) return []
  const rows: string[] = []
  while (rest && rows.length < maxLines) {
    if (textWidth(rest) <= width || rows.length === maxLines - 1) {
      rows.push(fit(rest, width, ellipsis).trimEnd())
      break
    }
    let head = takeCells(rest, width)
    if (!head) { rows.push(fit(rest, width, ellipsis).trimEnd()); break }
    const space = head.lastIndexOf(' ')
    if (space > 0 && textWidth(head.slice(0, space)) >= width / 2) head = head.slice(0, space)
    rows.push(head.trimEnd())
    rest = rest.slice(head.length).trimStart()
  }
  return rows
}
