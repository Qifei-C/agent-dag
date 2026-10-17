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
    expect(s.nodes.a1!.inputTokens).toBe(105)   // input + cache read + cache creation
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
    // A tool event alone never creates a node: the engine's own forks (compaction,
    // memory) carry ids no list names, and would otherwise become phantom rows.
    s = apply(s, { kind: 'tool-start', agentId: 'ghost2', tool: 'Bash' })
    expect(s.nodes.ghost2).toBe(undefined)
    expect(s.order).toEqual([MAIN, 'ghost'])
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

describe('review fixes', () => {
  test('turn usage supplies the main model and updates the observed agent model', async () => {
    const usage = { model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 10,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    let s = spawn(freshState(0, 'cards'), 'a1')
    s = apply(s, { kind: 'turn-end', reason: 'answer', at: 100, usage })
    expect(s.nodes[MAIN]!.model).toBe('claude-haiku-5-5')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 100, usage })
    expect(s.nodes.a1!.model).toBe('claude-haiku-5-5')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 200 })
    expect(s.nodes.a1!.model).toBe('claude-haiku-5-5')
  })

  test('a spawn that lands after the first turn started keeps running and the current tool', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'turn-start', agentId: 'a1', at: 100 })
    s = apply(s, { kind: 'tool-start', agentId: 'a1', tool: 'Read' })
    s = spawn(s, 'a1', MAIN, { label: 'late spawn', at: 101 })
    expect(s.nodes.a1!.status).toBe('running')
    expect(s.nodes.a1!.currentTool).toBe('Read')
    expect(s.nodes.a1!.label).toBe('late spawn')
    expect(s.nodes.a1!.turns).toBe(1)
    expect(s.nodes.a1!.startedAt).toBe(100)
  })

  test('reconcile promotes pending or waiting to running, never an ended node', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'reconcile', at: 5, agents: [{ id: 'a1', status: 'running' }] })
    expect(s.nodes.a1!.status).toBe('running')
    s = apply(s, { kind: 'reconcile', at: 6, agents: [{ id: 'a1', status: 'waiting' }] })
    expect(s.nodes.a1!.status).toBe('waiting')
    s = apply(s, { kind: 'reconcile', at: 7, agents: [{ id: 'a1', status: 'running' }] })
    expect(s.nodes.a1!.status).toBe('running')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 8 })
    s = apply(s, { kind: 'reconcile', at: 9, agents: [{ id: 'a1', status: 'running' }] })
    expect(s.nodes.a1!.status).toBe('completed')
  })

  test('a node first seen at turn-start starts running at that time', async () => {
    const s = apply(freshState(0, 'tree'), { kind: 'turn-start', agentId: 'late', at: 4321 })
    expect(s.nodes.late!.status).toBe('running')
    expect(s.nodes.late!.startedAt).toBe(4321)
  })

  test('reconcile fills a placeholder with the list\'s description, type and parent', async () => {
    let s = spawn(freshState(0, 'tree'), 'lead')
    s = apply(s, { kind: 'turn-start', agentId: 'fk', at: 1 })
    expect(s.nodes.fk!.label).toBe('agent')
    s = apply(s, { kind: 'reconcile', at: 2, agents: [{ id: 'fk', status: 'running', description: 'review skill', type: 'fork', parentId: 'lead' }] })
    expect(s.nodes.fk!.label).toBe('review skill')
    expect(s.nodes.fk!.type).toBe('fork')
    expect(s.nodes.fk!.parentId).toBe('lead')
    // a node the spawn labelled keeps its label
    s = apply(s, { kind: 'reconcile', at: 3, agents: [{ id: 'lead', status: 'running', description: 'other', type: 'Plan' }] })
    expect(s.nodes.lead!.label).toBe('task lead')
  })

  test('reconcile does not resurrect ended agents the engine still lists', async () => {
    let s = freshState(0, 'tree')
    s = apply(s, { kind: 'reconcile', at: 1, agents: [
      { id: 'old', status: 'completed', description: 'old task', type: 'Explore' },
      { id: 'live', status: 'running', description: 'live task', type: 'Explore' },
    ] })
    expect(s.nodes.old).toBe(undefined)
    expect(s.nodes.live!.label).toBe('live task')
    expect(s.order).toEqual([MAIN, 'live'])
  })

  test('tokens count cached input too', async () => {
    let s = spawn(freshState(0, 'tree'), 'a1')
    s = apply(s, { kind: 'turn-end', agentId: 'a1', reason: 'answer', at: 1,
      usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 25_000 } })
    expect(s.nodes.a1!.inputTokens).toBe(205_100)
    expect(s.nodes.a1!.outputTokens).toBe(7)
  })
})
