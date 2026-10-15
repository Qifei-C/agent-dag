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

export const fit = (text: string, width: number, ellipsis = '…'): string => {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length <= width) return text + ' '.repeat(width - chars.length)
  if (width === 1) return ellipsis
  return chars.slice(0, width - 1).join('') + ellipsis
}

export const padLeft = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text
