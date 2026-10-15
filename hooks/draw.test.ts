import { test, expect, describe } from 'claude-code/testing'
import { MAIN, apply, freshState } from './model'
import { treeRows, cards, messageRows, summary, plainText, visibleColumns } from './draw'
import type { DagState } from '../types'

const sample = (): DagState => {
  let s = freshState(0, 'tree')
  s = apply(s, { kind: 'turn-start', agentId: undefined, at: 0 })
  s = apply(s, { kind: 'spawn', agentId: 'a1', parentId: MAIN, label: 'find callers', type: 'Explore', isTeammate: false, model: 'claude-haiku-5-5', at: 1000 })
  s = apply(s, { kind: 'turn-start', agentId: 'a1', at: 1000 })
  s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 13_000, usage: { input_tokens: 4000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  s = apply(s, { kind: 'spawn', agentId: 'a2', parentId: MAIN, label: 'review diff', type: 'fork', isTeammate: false, model: 'claude-fable-5-1', at: 2000 })
  s = apply(s, { kind: 'turn-start', agentId: 'a2', at: 2000 })
  s = apply(s, { kind: 'tool-start', agentId: 'a2', tool: 'Bash' })
  s = apply(s, { kind: 'spawn', agentId: 'a3', parentId: 'a2', label: 'outline fix', type: 'Plan', isTeammate: false, model: 'claude-sonnet-5-5', at: 3000 })
  s = apply(s, { kind: 'spawn', agentId: 'a4', parentId: MAIN, label: 'run tests', type: 'general-purpose', isTeammate: false, model: 'claude-sonnet-5-5', at: 4000 })
  s = apply(s, { kind: 'turn-end', agentId: 'a4', reason: 'error', at: 9000 })
  s = apply(s, { kind: 'message', from: 'a2', to: MAIN, text: 'done, three callers found in src', at: 5000 })
  s = apply(s, { kind: 'message', from: MAIN, to: 'a2', text: 'stop after this file', at: 6000 })
  return s
}
const o = (columns: number, glyphs: 'unicode' | 'ascii' = 'unicode') => ({ columns, glyphs, now: 33_000 })
const text = (rows: ReturnType<typeof treeRows>) => rows.map(r => r.map(s => s.text).join(''))

describe('visibleColumns', () => {
  test('drops right to left at the thresholds', async () => {
    expect(visibleColumns(100)).toEqual({ status: true, tokens: true, model: true, tool: true })
    expect(visibleColumns(72)).toEqual({ status: true, tokens: true, model: true, tool: true })
    expect(visibleColumns(71)).toEqual({ status: true, tokens: true, model: true, tool: false })
    expect(visibleColumns(59)).toEqual({ status: true, tokens: true, model: false, tool: false })
    expect(visibleColumns(47)).toEqual({ status: true, tokens: false, model: false, tool: false })
    expect(visibleColumns(39)).toEqual({ status: false, tokens: false, model: false, tool: false })
  })
})

describe('treeRows', () => {
  test('one row per node, depth-first, with connectors and columns at 100', async () => {
    const rows = text(treeRows(sample(), o(100)))
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatch(/^◐ main/)
    expect(rows[1]).toMatch(/^├─✓ Explore: find callers/)
    expect(rows[1]).toMatch(/done\s+12s\s+4\.1k\s+haiku\s*$/)
    expect(rows[2]).toMatch(/^├─◐ fork: review diff/)
    expect(rows[2]).toMatch(/running\s+31s\s+0\s+fable\s+Bash$/)
    expect(rows[3]).toMatch(/^│ └─◌ Plan: outline fix/)
    expect(rows[4]).toMatch(/^└─✗ run tests/)
    expect(rows[4]).toMatch(/failed/)
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(100)
  })

  test('label omits the type prefix for general-purpose, teammate and claude', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'spawn', agentId: 't', parentId: MAIN, label: 'scout', type: 'teammate', isTeammate: true, at: 1 })
    s = apply(s, { kind: 'spawn', agentId: 'c', parentId: MAIN, label: 'misc', type: 'claude', isTeammate: false, at: 1 })
    const rows = text(treeRows(s, o(80)))
    expect(rows[1]).toMatch(/^├─◌ scout/)
    expect(rows[2]).toMatch(/^└─◌ misc/)
  })

  test('columns drop as the pane narrows and rows never exceed the width', async () => {
    for (const w of [72, 60, 56, 48, 44, 40, 36, 30]) {
      const rows = text(treeRows(sample(), o(w)))
      for (const r of rows) expect([...r].length).toBeLessThanOrEqual(w)
    }
    expect(text(treeRows(sample(), o(71)))[2]).not.toMatch(/Bash/)
    expect(text(treeRows(sample(), o(59)))[2]).not.toMatch(/fable/)
    expect(text(treeRows(sample(), o(47)))[1]).not.toMatch(/4\.1k/)
    expect(text(treeRows(sample(), o(39)))[1]).not.toMatch(/done/)
  })

  test('30 columns draws glyph + label only, label at least 12 wide', async () => {
    const rows = text(treeRows(sample(), o(30)))
    expect(rows[1]).toMatch(/^├─✓ Explore: fi/)
    expect(rows[1]).toMatch(/\d+s$/)
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(30)
  })

  test('ascii glyphs when asked', async () => {
    const rows = text(treeRows(sample(), o(80, 'ascii')))
    expect(rows[1]).toMatch(/^\|-\+ /)
    expect(rows[4]).toMatch(/^`-x /)
    for (const r of rows) expect([...r].every(c => c.charCodeAt(0) < 0x80)).toBe(true)
  })

  test('elapsed runs for running nodes and freezes for ended ones', async () => {
    const a = text(treeRows(sample(), o(100)))
    const b = text(treeRows(sample(), { ...o(100), now: 93_000 }))
    expect(a[1]).toMatch(/12s/)
    expect(b[1]).toMatch(/12s/)
    expect(a[2]).toMatch(/31s/)
    expect(b[2]).toMatch(/1m31s/)
  })

  test('workflow agents are grouped under a synthetic run row', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'spawn', agentId: 'w1', parentId: MAIN, label: 'review:bugs', type: 'general-purpose', isTeammate: false, workflowRunId: 'wf_abc123', at: 1 })
    s = apply(s, { kind: 'spawn', agentId: 'w2', parentId: MAIN, label: 'review:perf', type: 'general-purpose', isTeammate: false, workflowRunId: 'wf_abc123', at: 1 })
    s = apply(s, { kind: 'turn-start', agentId: 'w1', at: 2 })
    const rows = text(treeRows(s, o(80)))
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatch(/^└─◐ workflow wf_abc123/)
    expect(rows[2]).toMatch(/^  ├─◐ review:bugs/)
    expect(rows[3]).toMatch(/^  └─◌ review:perf/)
  })

  test('status rows carry the status color', async () => {
    const rows = treeRows(sample(), o(100))
    const glyph = rows[4]!.find(seg => seg.text.includes('✗'))
    expect(glyph?.color).toBe('error')
  })
})

describe('cards', () => {
  test('one card per node with three inner rows and tool chips', async () => {
    const cs = cards(sample(), o(80))
    expect(cs).toHaveLength(5)
    expect(cs[2]!.depth).toBe(1)
    expect(cs[2]!.status).toBe('running')
    const inner = cs[2]!.rows.map(r => r.map(s => s.text).join(''))
    expect(inner[0]).toMatch(/^◐ fork: review diff/)
    expect(inner[1]).toMatch(/running 31s · fable · 0 · 1 turn/)
    expect(inner[2]).toMatch(/▸ Bash/)
    expect(cs[3]!.depth).toBe(2)
    for (const c of cs) for (const r of c.rows) expect([...r.map(s => s.text).join('')].length).toBeLessThanOrEqual(80 - 4 - 2 * c.depth)
  })

  test('tool chips row is omitted when showTools is false', async () => {
    const s = apply(sample(), { kind: 'set-flags', showTools: false })
    expect(cards(s, o(80))[2]!.rows).toHaveLength(2)
  })
})

describe('messageRows', () => {
  test('lists edges newest first with counts and quotes', async () => {
    const rows = text(messageRows(sample(), o(80)))
    expect(rows[0]).toBe('messages')
    expect(rows[1]).toMatch(/^  main → review diff\s+1\s+"stop after this file"/)
    expect(rows[2]).toMatch(/^  review diff → main\s+1\s+"done, three callers found in src"/)
  })
  test('drops the quote below 60 columns and is empty with no messages', async () => {
    expect(text(messageRows(sample(), o(59)))[1]).not.toMatch(/"/)
    expect(messageRows(freshState(0, 'tree'), o(80))).toEqual([])
  })
  test('hidden when showMessages is false', async () => {
    expect(messageRows(apply(sample(), { kind: 'set-flags', showMessages: false }), o(80))).toEqual([])
  })
})

describe('summary and plainText', () => {
  test('summary counts agents without main', async () => {
    expect(summary(sample(), 'unicode')).toBe('4 agents · 1 running')
    expect(summary(freshState(0, 'tree'), 'ascii')).toBe('0 agents - 0 running')
  })
  test('plainText joins rows', async () => {
    expect(plainText([[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]])).toBe('ab\nc')
  })
})
