import { test, expect, describe, mock } from 'claude-code/testing'
import type { AgentSpawnInput, CommandRunInput, SessionSendInput } from 'claude-code'

/** The whole agent.spawn input, as the engine's call site passes it. */
const spawnOf = (a: { description: string; subagentType: string; name: string }): AgentSpawnInput => ({
  tool_use_id: `tu-${a.name}`, prompt: 'task', description: a.description, subagentType: a.subagentType,
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: false, fork: false, name: a.name,
})
const sendOf = (to: string, text: string): SessionSendInput => ({ to, text, origin: { kind: 'model' } })
const runOf = (args: string): CommandRunInput => ({
  command: 'dag', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 },
})

const PANE_PROPS = {
  title: 'Agents', isFocused: false, bodyColumns: 100, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 }, view: {},
}

/** Registers the bottom hooks a session would answer, and starts the session. */
const boot = async ($: any, on: any, opts: { placed?: boolean } = {}) => {
  const clock = mock.clock(on, { now: 10_000 })
  const opened: string[] = []
  const closed: string[] = []
  const listed: any[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.close', (_: any, e: any) => { closed.push(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: opened.length > closed.length
    ? [{ id: 'agent-dag', title: 'Agents', isShown: true, isFocused: false, isPlaced: opts.placed ?? true }] : [] }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('ui.open', (_: any, e: any) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('agent.list', () => ({ value: listed }))
  on('agent.spawn', (_: any, e: any) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: e.name ?? 'a1' }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok', text: 'ok', isError: false }))
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
  return { clock, opened, closed, listed }
}

const rowsOf = async (ui: any) =>
  (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

describe('agent-dag pane', () => {
  test('empty state on both surfaces', async ($, on) => {
    await boot($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-dag', surface, component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
      expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a spawn opens the pane and draws the agent row', async ($, on) => {
    const { opened } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'find callers', subagentType: 'Explore', name: 'a1' }))
    expect(opened).toEqual(['agent-dag'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-dag', surface, component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
      expect(await ui.find({ type: 'Text', text: /Explore: find callers/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /pending/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('turn.start, tool.call and turn.complete move the row', async ($, on) => {
    const { clock } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'find callers', subagentType: 'Explore', name: 'a1' }))
    await $.turn.start({ text: 'look', turnId: 't1', agentId: 'a1' })
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /running/ })).toBeDefined()
    await $.tool.call({ tool: 'Read', file_path: '/tmp/x/a' })      // runs in the main loop; counted on main
    expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
    await clock.advance(12_000)
    await $.turn.complete({ answer: 'found 3', durationMs: 12_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
      usage: { model: 'claude-haiku-5-5', input_tokens: 4000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(await ui.find({ type: 'Text', text: /done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4\.1k/ })).toBeDefined()
    await ui.unmount()
  })

  test('a SendMessage from main to an agent lists a message edge', async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'review diff', subagentType: 'general-purpose', name: 'rev' }))
    await $.session.send(sendOf('rev', 'stop after this file'))
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^messages/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main → review diff/ })).toBeDefined()
    await ui.unmount()
  })

  test('the tick redraws elapsed time and reconciles with agent.list', async ($, on) => {
    const { clock, listed } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'slow one', subagentType: 'general-purpose', name: 'a1' }))
    await $.turn.start({ text: 'x', turnId: 't1', agentId: 'a1' })
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    await clock.advance(65_000)
    expect(await ui.find({ type: 'Text', text: /1m0\ds/ })).toBeDefined()
    listed.push({ id: 'a1', status: 'killed', description: 'slow one', type: 'general-purpose' })
    await clock.advance(5_000)
    expect(await ui.find({ type: 'Text', text: /killed/ })).toBeDefined()
    await ui.unmount()
  })

  test('footer buttons switch view and fold messages', async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'review diff', subagentType: 'fork', name: 'rev' }))
    await $.session.send(sendOf('rev', 'hi'))
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    expect(await ui.find({ type: 'Button', key: 'view' })).toBeDefined()
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /1 turn|0 turns/ })).toBeDefined()   // a card's meta row
    await ui.press({ key: 'messages' })
    expect(await ui.find({ type: 'Text', text: /^messages/ })).toBe(undefined)
    await ui.unmount()
  })

  test('a narrow pane offers no cards button', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: { ...PANE_PROPS, bodyColumns: 40 } })
    expect(await ui.find({ type: 'Button', key: 'view' })).toBe(undefined)
    await ui.unmount()
  })

  test('a draw failure is reported in the pane, not thrown', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: { ...PANE_PROPS, bodyColumns: Number.NaN } })
    expect(await ui.drawn()).toBeDefined()
    await ui.unmount()
  })
})

describe('agent-dag options', () => {
  test('ascii glyphs from userConfig', { options: { glyphs: 'ascii' } }, async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'find callers', subagentType: 'Explore', name: 'a1' }))
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    const rows = await rowsOf(ui)
    expect(rows.some((r: string) => /^`-\. /.test(r))).toBe(true)
    expect(rows.every((r: string) => [...r].every(c => c.charCodeAt(0) < 0x80))).toBe(true)
    await ui.unmount()
  })

  test('autoOpen false never opens the pane by itself', { options: { autoOpen: false } }, async ($, on) => {
    const { opened } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))
    expect(opened).toEqual([])
  })

  test('defaultView cards starts in cards', { options: { defaultView: 'cards' } }, async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /0 turns/ })).toBeDefined()
    await ui.unmount()
  })
})
describe('/dag command', () => {
  test('bare /dag toggles the pane', async ($, on) => {
    const { opened, closed } = await boot($, on)
    const a = await $.command.run(runOf(''))
    expect(opened).toEqual(['agent-dag'])
    expect(a.text).toMatch(/opened/)
    const b = await $.command.run(runOf(''))
    expect(closed).toEqual(['agent-dag'])
    expect(b.text).toMatch(/closed/)
  })

  test('/dag inspect prints the tree and messages as text', async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'find callers', subagentType: 'Explore', name: 'a1' }))
    await $.session.send(sendOf('a1', 'go'))
    const out = await $.command.run(runOf('inspect'))
    expect(out.text).toMatch(/main/)
    expect(out.text).toMatch(/Explore: find callers/)
    expect(out.text).toMatch(/messages/)
    expect(out.text).toMatch(/main → find callers/)   // message rows use bare labels
  })

  test('/dag reset forgets agents but keeps main', async ($, on) => {
    await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))
    const out = await $.command.run(runOf('reset'))
    expect(out.text).toBe('Agent graph reset.')
    const ui = await $.ui.mount({ plugin: 'agent-dag', surface: 'terminal', component: 'Pane', requestId: 'agent-dag', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('/dag with an unknown argument answers usage', async ($, on) => {
    await boot($, on)
    const out = await $.command.run(runOf('bogus'))
    expect(out.text).toMatch(/usage: \/dag \[inspect\|reset\]/i)
  })

  test("a deliberate close suppresses auto-open until /dag", async ($, on) => {
    // The kit's $ cannot raise ui.close with origin person; the /dag close
    // goes through the same suppression, so the rule is exercised through it.
    const { opened, closed } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))
    expect(opened).toEqual(['agent-dag'])
    await $.command.run(runOf(''))   // closes
    expect(closed).toEqual(['agent-dag'])
    await $.agent.spawn(spawnOf({ description: 'b', subagentType: 'Explore', name: 'a2' }))
    expect(opened).toEqual(['agent-dag'])
    await $.command.run(runOf(''))   // reopens
    expect(opened).toEqual(['agent-dag', 'agent-dag'])
  })

  test('a second spawn after the first auto-open does not reopen', async ($, on) => {
    const { opened } = await boot($, on)
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))
    await $.agent.spawn(spawnOf({ description: 'b', subagentType: 'Explore', name: 'a2' }))
    expect(opened).toEqual(['agent-dag'])
  })
})

describe('/dag on a pane the engine holds undrawn', () => {
  test('/dag re-opens (asked) instead of closing a pane nobody can see', async ($, on) => {
    const { opened, closed } = await boot($, on, { placed: false })
    await $.agent.spawn(spawnOf({ description: 'a', subagentType: 'Explore', name: 'a1' }))   // unasked open: waits undrawn
    expect(opened).toEqual(['agent-dag'])
    const out = await $.command.run(runOf(''))
    expect(out.text).toMatch(/opened/)
    expect(closed).toEqual([])
    expect(opened).toEqual(['agent-dag', 'agent-dag'])
  })
})
