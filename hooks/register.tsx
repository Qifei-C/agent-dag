import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DagState, GlyphSet, View } from '../types'
import { MAIN, apply, freshState, isActive, loopId } from './model'
import type { DagEvent, ListedAgent } from './model'
import { cards, messageRows, plainText, summary, treeRows } from './draw'
import type { Row, Segment } from './draw'
import { STATUS_COLOR } from './format'

export const PANE = 'agent-dag'
const TITLE = 'Agents'
const TICK_MS = 1000
const RECONCILE_EVERY = 5
const CARDS_MIN_COLUMNS = 44

export const dag = atom({ plugin: 'agent-dag', key: 'dag' } as const, freshState(0, 'tree'), { shape: 'v1' })

type Options = { glyphs: GlyphSet; autoOpen: boolean; defaultView: View }

const readOptions = (raw: Readonly<Record<string, unknown>>): Options => ({
  glyphs: raw.glyphs === 'ascii' ? 'ascii' : 'unicode',
  autoOpen: raw.autoOpen !== false,
  defaultView: raw.defaultView === 'cards' ? 'cards' : 'tree',
})

type Dollar = Parameters<typeof update>[0] & { ui: { open: (pane: { id: string; title?: string }) => Promise<unknown> } }

/** Folds one event into the shared graph state. */
async function dispatch($: Parameters<typeof update>[0], ev: DagEvent): Promise<void> {
  await update($, dag, s => apply(s, ev))
}

/** Opens the pane: always when the person asked, else once per session unless they closed it. */
async function openPane($: Dollar, options: Options, asked: boolean): Promise<void> {
  const s = await read($, dag)
  if (!asked && (!options.autoOpen || s.isClosedByPerson || s.hasOpened)) return
  await dispatch($, { kind: 'set-flags', hasOpened: true, isClosedByPerson: asked ? false : s.isClosedByPerson })
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, rawOptions) => {
  const options = readOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    // A hot reload keeps the graph; a fresh session starts clean in the configured view.
    await update($, dag, s => (s.order.length > 1 ? s : freshState(now, options.defaultView)))
    await $.command.register({ name: 'dag', description: 'Toggle the Agents pane; `inspect` prints the tree, `reset` clears it', argumentHint: '[inspect|reset]' })

    let ticks = 0
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const s = await read($, dag)
        if (s.order.length <= 1) return
        const at = await $.clock.now()
        ticks += 1
        if (isActive(s)) await dispatch($, { kind: 'tick', at })
        if (ticks % RECONCILE_EVERY === 0) {
          try {
            const agents = (await $.agent.list()) as ListedAgent[]
            await dispatch($, { kind: 'reconcile', agents, at })
          } catch { /* next tick */ }
        }
      })()
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await dispatch($, { kind: 'reset', at: await $.clock.now() })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) {
      await dispatch($, {
        kind: 'spawn', agentId: started.agentId, parentId: loopId(e.parentAgentId),
        label: e.description || e.name || e.subagentType, type: e.subagentType,
        isTeammate: e.isTeammate === true, name: e.name, teammateId: started.teammateId,
        workflowRunId: e.workflow?.runId, model: started.model, at: await $.clock.now(),
      })
      await openPane($, options, false)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await dispatch($, { kind: 'turn-start', agentId: e.agentId, at: await $.clock.now() })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await dispatch($, { kind: 'tool-start', agentId: e.agentId, tool: String(e.tool) })
    try {
      return await next(e)
    } finally {
      await dispatch($, { kind: 'tool-end', agentId: e.agentId, tool: String(e.tool) })
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await dispatch($, { kind: 'turn-end', agentId: e.agentId, reason: e.reason, usage: e.usage, at: await $.clock.now() })
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (sent.isDelivered) {
      await dispatch($, { kind: 'message', from: loopId(e.agentId), to: e.to, text: e.text, at: await $.clock.now() })
    }
    return sent
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await dispatch($, { kind: 'set-flags', isClosedByPerson: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dag' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const now = await $.clock.now()
    if (arg === 'inspect') {
      const s = await read($, dag)
      const o = { columns: 80, glyphs: options.glyphs, now }
      const msgs = messageRows(s, o)
      const rows = [...treeRows(s, o), ...(msgs.length ? [[{ text: '' }], ...msgs] : [])]
      return { text: '```\n' + plainText(rows) + '\n```' }
    }
    if (arg === 'reset') {
      await dispatch($, { kind: 'reset', at: now })
      return { text: 'Agent graph reset.' }
    }
    if (arg !== '') return { text: 'usage: /dag [inspect|reset]' }
    // Open means drawn: an unasked open below the engine's width floor waits
    // undrawn, and the person's /dag must then seat it, not close it.
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
    if (isOpen) {
      // A close the person asked for: no auto-reopen until they ask again.
      await dispatch($, { kind: 'set-flags', isClosedByPerson: true })
      await $.ui.close({ id: PANE })
      return { text: 'Agents pane closed.' }
    }
    await openPane($, options, true)
    return { text: 'Agents pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, dag)
    const columns = Number.isFinite(e.props.bodyColumns) && e.props.bodyColumns > 0 ? Math.floor(e.props.bodyColumns) : 60
    const now = await $.clock.now()
    const o = { columns, glyphs: options.glyphs, now }

    const seg = (x: Segment, i: number) => (
      <Text key={`s${i}`} color={x.color} dimColor={x.dim} weight={x.bold ? 'semibold' : undefined}>{x.text}</Text>
    )
    const line = (r: Row, i: number) => <Text key={`r${i}`} wrap="truncate-end">{r.map(seg)}</Text>

    try {
      const hasAgents = s.order.length > 1
      const body = !hasAgents
        ? [<Text key="empty" dimColor>No agents yet. The pane fills when the session spawns one.</Text>]
        : s.view === 'cards' && columns >= CARDS_MIN_COLUMNS
          ? cards(s, o).map((c, i) => (
              <Box key={`c${i}`} marginLeft={2 * c.depth} borderStyle="round" borderColor={STATUS_COLOR[c.status].color}
                borderDimColor={STATUS_COLOR[c.status].dim} flexDirection="column" paddingX={1}>
                {c.rows.map(line)}
              </Box>
            ))
          : treeRows(s, o).map(line)
      const msgs = hasAgents ? messageRows(s, o) : []
      const canCards = columns >= CARDS_MIN_COLUMNS
      return (
        <Box flexDirection="column">
          <Box flexDirection="column">{body}</Box>
          {msgs.length > 0 && <Box flexDirection="column" marginTop={1}>{msgs.map(line)}</Box>}
          <Box marginTop={1} justifyContent="space-between">
            <Box gap={1}>
              {canCards && (
                <Button key="view" hotkey="v" plain label={s.view === 'cards' ? 'tree' : 'cards'}
                  onPress={() => update($, dag, st => apply(st, { kind: 'set-flags', view: st.view === 'cards' ? 'tree' : 'cards' }))} />
              )}
              <Button key="messages" hotkey="m" plain label="messages"
                onPress={() => update($, dag, st => apply(st, { kind: 'set-flags', showMessages: !st.showMessages }))} />
              <Button key="tools" hotkey="t" plain label="tools"
                onPress={() => update($, dag, st => apply(st, { kind: 'set-flags', showTools: !st.showTools }))} />
            </Box>
            <Text dimColor>{summary(s, options.glyphs)}</Text>
          </Box>
        </Box>
      )
    } catch (err) {
      return <Text dimColor>agent-dag: draw failed ({err instanceof Error ? err.message : String(err)})</Text>
    }
  })
}
