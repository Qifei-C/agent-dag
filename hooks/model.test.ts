import { test, expect, describe } from 'claude-code/testing'
import { MAIN, apply, freshState, resolveAddress, isActive, children, shortModel } from './model'
import type { DagState } from '../types'

const spawn = (s: DagState, id: string, parent = MAIN, extra: Record<string, unknown> = {}) =>
  apply(s, { kind: 'spawn', agentId: id, parentId: parent, label: `task ${id}`, type: 'general-purpose',
    isTeammate: false, model: 'claude-sonnet-5-5', at: 1000, ...extra } as any)

describe('reducer', () => {
  test('freshState has only main, idle', async () => {
    const s = freshState(500, 'tree')
    expect(Object.keys(s.nodes)).toEqual([MAIN])
    expect(s.nodes[MAIN]!.status).toBe('idle')
    expect(s.nodes[MAIN]!.startedAt).toBe(500)
    expect(s.order).toEqual([MAIN])
    expect(s.view).toBe('tree')
  })

  test('spawn, turn-start, tool, turn-end completes a subagent', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    expect(s.nodes.a1!.status).toBe('pending')
    expect(s.nodes.a1!.parentId).toBe(MAIN)
    expect(s.nodes.a1!.model).toBe('claude-sonnet-5-5')
    expect(s.order).toEqual([MAIN, 'a1'])
    s = apply(s, { kind: 'turn-start', agentId: 'a1', at: 1100 })
    expect(s.nodes.a1!.status).toBe('running')
    expect(s.nodes.a1!.turns).toBe(1)
    s = apply(s, { kind: 'tool-start', agentId: 'a1', tool: 'Read' })
    expect(s.nodes.a1!.currentTool).toBe('Read')
    s = apply(s, { kind: 'tool-end', agentId: 'a1', tool: 'Read' })
    expect(s.nodes.a1!.currentTool).toBe(undefined)
    expect(s.nodes.a1!.toolCount).toBe(1)
    expect(s.nodes.a1!.recentTools).toEqual(['Read'])
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 5000,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } })
    expect(s.nodes.a1!.status).toBe('completed')
    expect(s.nodes.a1!.endedAt).toBe(5000)
    expect(s.nodes.a1!.inputTokens).toBe(100)
    expect(s.nodes.a1!.outputTokens).toBe(20)
  })

  test('tool-end clears currentTool only when it matches', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'tool-start', agentId: 'a1', tool: 'Bash' })
    s = apply(s, { kind: 'tool-start', agentId: 'a1', tool: 'Read' })
    s = apply(s, { kind: 'tool-end', agentId: 'a1', tool: 'Bash' })
    expect(s.nodes.a1!.currentTool).toBe('Read')
    expect(s.nodes.a1!.toolCount).toBe(1)
  })

  test('recentTools keeps the last six', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      s = apply(s, { kind: 'tool-start', agentId: 'a1', tool: t })
      s = apply(s, { kind: 'tool-end', agentId: 'a1', tool: t })
    }
    expect(s.nodes.a1!.recentTools).toEqual(['B', 'C', 'D', 'E', 'F', 'G'])
  })

  test('turn-end reasons map to statuses; teammates and main go idle', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = spawn(s, 'tm', MAIN, { isTeammate: true, type: 'teammate', name: 'scout' })
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'aborted', at: 1 })
    expect(s.nodes.a1!.status).toBe('killed')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'error', at: 2 })
    expect(s.nodes.a1!.status).toBe('failed')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'refusal', at: 3 })
    expect(s.nodes.a1!.status).toBe('failed')
    s = apply(s, { kind: 'turn-end', agentId: 'tm', reason: 'answer', at: 4 })
    expect(s.nodes.tm!.status).toBe('idle')
    s = apply(s, { kind: 'turn-start', agentId: undefined, at: 5 })
    expect(s.nodes[MAIN]!.status).toBe('running')
    s = apply(s, { kind: 'turn-end', agentId: undefined, reason: 'answer', at: 6 })
    expect(s.nodes[MAIN]!.status).toBe('idle')
  })

  test('turn-end without usage keeps token counts', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 1,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'aborted', at: 2 })
    expect(s.nodes.a1!.inputTokens).toBe(10)
    expect(s.nodes.a1!.outputTokens).toBe(1)
  })

  test('creates a node on the fly for an unknown agent id', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'turn-start', agentId: 'ghost', at: 7 })
    expect(s.nodes.ghost!.parentId).toBe(MAIN)
    expect(s.nodes.ghost!.label).toBe('agent')
    expect(s.nodes.ghost!.status).toBe('running')
    expect(s.order).toEqual([MAIN, 'ghost'])
    s = apply(s, { kind: 'tool-start', agentId: 'ghost2', tool: 'Bash' })
    expect(s.nodes.ghost2!.currentTool).toBe('Bash')
  })

  test('respawn under the same id keeps the node and resets status', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 1 })
    s = spawn(s, 'a1', MAIN, { label: 'resumed' })
    expect(s.nodes.a1!.status).toBe('pending')
    expect(s.nodes.a1!.label).toBe('resumed')
    expect(s.order).toEqual([MAIN, 'a1'])
  })

  test('nested spawn keeps the parent chain', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = spawn(s, 'a2', 'a1')
    expect(s.nodes.a2!.parentId).toBe('a1')
    expect(children(s, 'a1').map(n => n.id)).toEqual(['a2'])
    expect(children(s, MAIN).map(n => n.id)).toEqual(['a1'])
  })

  test('spawn with a parent the model never saw creates that parent', async () => {
    let s = spawn(freshState(0, 'tree'), 'a2', 'a1')
    expect(s.nodes.a1).toBeDefined()
    expect(s.nodes.a1!.parentId).toBe(MAIN)
    expect(s.order).toEqual([MAIN, 'a1', 'a2'])
  })
})

describe('messages', () => {
  test('two sends make one edge with count 2', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'message', from: 'a1', to: MAIN, text: 'first', at: 1 })
    s = apply(s, { kind: 'message', from: 'a1', to: MAIN, text: 'second', at: 2 })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!).toMatchObject({ from: 'a1', to: MAIN, count: 2, lastAt: 2, lastText: 'second' })
  })

  test('a send to a name resolves to the node id', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1', MAIN, { name: 'reviewer' })
    expect(resolveAddress(s, 'reviewer')).toBe('a1')
    s = apply(s, { kind: 'message', from: MAIN, to: 'reviewer', text: 'go', at: 1 })
    expect(s.messages[0]!.to).toBe('a1')
  })

  test('a send to a teammateId resolves to the node id', async () => {
    let s = spawn(freshState(0, 'tree'), 'tm', MAIN, { isTeammate: true, teammateId: 'scout@team' })
    expect(resolveAddress(s, 'scout@team')).toBe('tm')
  })

  test('message to an unknown address keeps the raw address', async () => {
    let s = apply(freshState(0, 'tree'), { kind: 'message', from: MAIN, to: 'nobody-here', text: 'x', at: 1 })
    expect(s.messages[0]!.to).toBe('nobody-here')
  })

  test('lastText is cut to 60 characters', async () => {
    const long = 'y'.repeat(100)
    const s = apply(freshState(0, 'tree'), { kind: 'message', from: MAIN, to: 'z', text: long, at: 1 })
    expect(s.messages[0]!.lastText).toHaveLength(60)
  })
})

describe('reconcile, tick, reset, flags', () => {
  test('reconcile takes ended and idle statuses from the list, not running', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = spawn(s, 'a2')
    s = apply(s, { kind: 'turn-start', agentId: 'a2', at: 1 })
    s = apply(s, { kind: 'reconcile', at: 9, agents: [
      { id: 'a1', status: 'killed', name: 'one' },
      { id: 'a2', status: 'running' },
      { id: 'a3', status: 'idle', teammateId: 'x@t', description: 'late', type: 'teammate' },
    ] })
    expect(s.nodes.a1!.status).toBe('killed')
    expect(s.nodes.a1!.name).toBe('one')
    expect(s.nodes.a1!.endedAt).toBe(9)
    expect(s.nodes.a2!.status).toBe('running')
    expect(s.nodes.a3!.label).toBe('late')
    expect(s.nodes.a3!.teammateId).toBe('x@t')
  })

  test('reconcile does not revive an ended node', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 1 })
    s = apply(s, { kind: 'reconcile', at: 2, agents: [{ id: 'a1', status: 'idle' }] })
    expect(s.nodes.a1!.status).toBe('completed')
  })

  test('tick bumps the counter; isActive reflects running or pending', async () => {
    let s = freshState(0, 'tree')
    expect(isActive(s)).toBe(false)
    s = apply(s, { kind: 'tick', at: 1 })
    expect(s.tick).toBe(1)
    s = spawn(s, 'a1')
    expect(isActive(s)).toBe(true)
  })

  test('reset keeps view flags and forgets nodes and messages', async () => {
    let s = spawn(freshState(0, 'cards'), 'a1')
    s = apply(s, { kind: 'message', from: 'a1', to: MAIN, text: 'hi', at: 1 })
    s = apply(s, { kind: 'set-flags', showMessages: false })
    s = apply(s, { kind: 'reset', at: 50 })
    expect(Object.keys(s.nodes)).toEqual([MAIN])
    expect(s.messages).toEqual([])
    expect(s.view).toBe('cards')
    expect(s.showMessages).toBe(false)
    expect(s.nodes[MAIN]!.startedAt).toBe(50)
  })

  test('set-flags updates only the given flags', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'set-flags', view: 'cards' })
    expect(s.view).toBe('cards')
    expect(s.showMessages).toBe(true)
    s = apply(s, { kind: 'set-flags', isClosedByPerson: true, hasOpened: true })
    expect(s.isClosedByPerson).toBe(true)
    expect(s.hasOpened).toBe(true)
  })
})

describe('shortModel', () => {
  test('aliases the known families and trims the rest', async () => {
    expect(shortModel('claude-fable-5-1')).toBe('fable')
    expect(shortModel('claude-opus-5-5')).toBe('opus')
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet')
    expect(shortModel('claude-haiku-5-5')).toBe('haiku')
    expect(shortModel('us.anthropic.claude-opus-5-5-v1')).toBe('opus')
    expect(shortModel('gpt-5-4-mini')).toBe('gpt-5-4-')
    expect(shortModel(undefined)).toBe('')
  })
})
