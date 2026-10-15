# agent-dag: live agent topology pane for Claude Code

Date: 2026-10-14
Status: draft for review

## Purpose

A Claude Code mod that shows, inside the terminal session itself, the agents a
session runs and how they relate: which loop spawned which, where each one
stands, what it is doing now, what it has cost, and which agents have messaged
each other. It is the terminal counterpart of dsh-task-dag (a DeepSeek Harness
Web panel) and of zoetrope (a standalone ratatui viewer), built as our own code
with no external binary and no dependency on either project.

Success: while a session fans out to subagents, teammates or a workflow, one
glance at the pane tells the person what is running, what finished, what
failed, and who talked to whom, without reading the transcript.

## Constraints and assumptions

- A mod of function hooks: three files plus a types contract, loaded by Claude
  Code's plugin engine. No Node, no DOM, no network, no file I/O.
- Drawn by Claude Code's own renderer, so it works wherever Claude Code's
  fullscreen TUI works: zsh or any shell, macOS and Linux. Verified in Ghostty
  (the person's terminal, `TERM=xterm-ghostty`), which draws box-drawing
  characters with its built-in renderer; status glyphs come from the font, so an
  ASCII glyph set is offered for terminals or fonts that lack them.
- Colors are theme keys only (`success`, `error`, `warning`, `claude`,
  `subtle`, `text`), never raw colors, so light and dark themes both read.
- Read-only: the mod never refuses, rewrites or delays a spawn, a tool call, a
  message or a turn. Every hook passes the event through and tolerates its own
  failure.
- The desktop surface is a bonus, not a target: the tree must validate there,
  but no desktop-only props are used.

## Scope

In scope:

- Subagents the Agent tool spawns (foreground and background), forks, agent
  teammates, workflow agents, and resumed runs.
- Messages between agents through SendMessage (`session.send`).
- A docked pane with two views (tree, cards), a footer of hotkeys, and a
  messages section.
- A `/dag` command with `inspect` and `reset` subcommands.
- Tests run by `claude plugin test`.

Out of scope (deliberately):

- Replay or timeline scrubbing of past sessions. The pane shows this session
  live; `/dag inspect` prints the current state.
- Reading transcript JSONL files. All data comes from engine events.
- A 2D node canvas with draggable nodes. The pane is a column of text.
- Workflow `blockedBy` dependency edges (dsh's only true DAG edges): Claude
  Code's workflow scripts do not expose them to hooks. Workflow agents appear
  under the main loop, grouped by run id.

## Architecture

```
events ──► reducer (pure) ──► $.state atoms ──► ui.render (pure) ──► pane
   agent.spawn, turn.start, tool.call, turn.complete,
   session.send, ui.close, command.run, clock tick, $.agent.list()
```

Three source files under `hooks/`:

- `register.tsx`: the hooks module. Wires events to the reducer, opens the
  pane, registers `/dag`, owns the tick timer, draws the pane.
- `model.ts`: the graph model and the pure reducer: `apply(state, event)`.
  No `$`, no JSX; the unit under test.
- `draw.ts`: pure layout helpers that turn the model into rows of text with
  column rules and glyph sets. No `$`, no JSX.

Plus `types/index.d.ts` (the `$.state` contract), `.claude-plugin/plugin.json`,
`hooks/hooks.json`, and `hooks/agent-dag.test.ts`.

## Data model

Kept in `$.state` under the plugin name `agent-dag` so a hot reload keeps the
graph. Cleared on `session.end` with reason `clear` and on `/dag reset`.

```ts
type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle'
                 | 'completed' | 'failed' | 'killed'

type AgentNode = {
  id: string            // 'main' for the main loop; else the engine's agentId
  parentId?: string     // spawning loop; 'main' when the main loop did
  label: string         // Agent call description, or name, or type
  type: string          // 'general-purpose', 'Explore', 'fork', 'teammate', ...
  name?: string         // SendMessage address when it has one
  isTeammate: boolean
  workflowRunId?: string
  model?: string        // resolved model id, shortened for display
  status: AgentStatus
  startedAt: number     // ms epoch of the spawn (main: session start)
  endedAt?: number      // ms epoch of the last turn end while not running
  turns: number
  inputTokens: number   // summed over turn.complete usage
  outputTokens: number
  toolCount: number
  currentTool?: string  // tool name while a call is in flight
  recentTools: string[] // last 6 tool names, oldest first
}

type MessageEdge = {
  from: string          // node id ('main' or agentId)
  to: string            // node id, or the raw address if unresolved
  count: number
  lastAt: number
  lastText: string      // first 60 chars of the last message
}

type DagState = {
  nodes: Record<string, AgentNode>
  messages: MessageEdge[]
  view: 'tree' | 'cards'
  showMessages: boolean
  showTools: boolean
  isClosedByPerson: boolean   // suppresses auto-reopen this session
  tick: number                // bumped by the timer to redraw elapsed times
}
```

The root node `main` always exists. Its label is `main`, its type `session`.

## Event handling

Each hook does its bookkeeping, then returns `next(e)` unchanged. A hook that
must read a result awaits `next(e)` first and does bookkeeping after, in a
`try/finally` so an error in the mod never changes what the engine does.

| Event | Effect on the model |
| --- | --- |
| `session.start` | Create `main` (status `idle`), register `/dag`, start the tick timer. |
| `agent.spawn` | After `next(e)` resolves with `agentId`: upsert node with parent `e.parentAgentId ?? 'main'`, label from `e.description` (fallback `e.name`, then `e.subagentType`), type, `isTeammate`, `workflowRunId` from `e.workflow?.runId`, model from the result, status `pending`. A `resume` reuses the node and sets `pending`. A `deny` result adds nothing. |
| `turn.start` | Node `e.agentId ?? 'main'`: status `running`, `turns += 1`. |
| `tool.call` | Before `next`: node `e.agentId ?? 'main'`: `currentTool = e.tool`. After: `toolCount += 1`, push to `recentTools` (cap 6), clear `currentTool` if it still equals this call's tool. A tool event for an id with no node is ignored: the engine's own forks (compaction, memory) carry ids no list names, and `turn.start` or reconcile is what creates a node. |
| `turn.complete` | Node `e.agentId ?? 'main'`: add `e.usage` tokens (input = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`, since `input_tokens` alone is only the uncached part of the prompt); status by reason: `answer` → `completed` for a subagent, `idle` for a teammate and for `main`; `aborted` → `killed`; `error` or `refusal` → `failed`. Set `endedAt`. |
| `session.send` | After `next(e)` resolves `isDelivered`: edge from `e.agentId ?? 'main'` to the node whose `id`, `name` or `teammateId` equals `e.to` (else the raw `e.to`), `count += 1`, `lastText`. |
| `ui.close` for our pane | If `e.origin.kind === 'person'`, set `isClosedByPerson`. |
| `session.end` reason `clear` | Reset the model to a fresh `main`. |
| tick (every 1 s; a no-op read while the tree holds only `main`; `tick` bumped only while a node is `running` or `pending`; reconcile every 5th tick) | Bump `tick`; reconcile with `$.agent.list()`: for each listed agent, take the list's status when it is `waiting`, `idle`, `completed`, `failed` or `killed` and ours is not ended, or `running` when ours is `pending` or `waiting`; fill `name`/`teammateId` we lack; fill a placeholder's label, type and parent from the list; never create a node for a listed agent that has already ended (so `/dag reset` holds). Nodes the list no longer has keep their last status. |

The tick timer is started in `session.start` with `$.clock.every`, so it
survives the dispatch and dies with the module. It re-arms itself at the
slower interval when nothing is active to stay cheap.

Auto-open: on the first `agent.spawn` of the session, if the pane is not open
and `isClosedByPerson` is false, `$.ui.open({ id: 'agent-dag', title: 'Agents' })`.
The engine seats an unasked open only from 144 columns (110 once the person
has opened that id by hand) and otherwise holds it open but undrawn
(`isPlaced: false`). `/dag` therefore treats the pane as open only when it is
placed and shown; an undrawn pane is re-opened as asked, which seats it at any
width, rather than closed.

## Rendering

One `ui.render` hook on `{ component: 'Pane', requestId: 'agent-dag' }`.
It reads the model, calls the pure layout in `draw.ts`, and emits `Box`/`Text`
rows plus a footer of `Button`s. Width comes from `e.props.bodyColumns`.

### Tree view (default)

One row per node, depth-first in spawn order, with box-drawing connectors:

```
● main                           running  1m02s   12.4k  fable   Agent
├─✓ Explore: find callers        done       12s    4.1k  haiku
├─◐ fork: review diff            running    31s    8.0k  fable   Bash
│ └─○ Plan: outline fix          waiting     4s    0.3k  sonnet
└─✗ claude: run tests            failed     40s    2.2k  sonnet
```

Columns after the label, right-aligned, in this order: status word, elapsed,
tokens (input+output, `k` with one decimal, `M` above a million), model
(short alias: `fable`, `opus`, `sonnet`, `haiku`, else the id's last segment
truncated to 8), current tool. Column drop order as the pane narrows, right
to left: tool below 72 columns, model below 60, tokens below 48, status word
below 40 (the glyph alone carries status). The label truncates with
`wrap="truncate-end"` to fill what is left, never below 12 columns.

Glyphs and colors by status:

| Status | Unicode | ASCII | Color |
| --- | --- | --- | --- |
| pending | ◌ | `.` | subtle |
| running | ◐ | `>` | claude |
| waiting | ○ | `o` | warning |
| idle | ● dim | `*` | subtle |
| completed | ✓ | `+` | success |
| failed | ✗ | `x` | error |
| killed | ⊘ | `-` | error dim |

Connectors: `├─ └─ │` (ASCII: `|- \`- |`). Arrow in the messages section:
`→` (ASCII `->`). The glyph set is the `glyphs` option (`unicode` default,
`ascii`), a picker in the config menu.

Elapsed is `now - startedAt` while running, `endedAt - startedAt` once ended,
formatted `12s`, `1m02s`, `1h03m`.

Workflow agents are grouped: a synthetic row `▸ workflow wf_…` (status from
its children: running if any runs, failed if any failed, else completed)
precedes its agents, which are drawn one level deeper.

### Cards view

Toggled by the `v` hotkey. Same order and depth as the tree, but each node is
a bordered `Box` (`borderStyle="round"`, border color by status) of three rows,
indented two columns per depth:

```
╭ ◐ fork: review diff ───────────────╮
│ running 31s · fable · 8.0k · 2 turns │
│ Read Grep Bash ▸ Bash                │
╰──────────────────────────────────────╯
```

Row three is the tool chips: `recentTools` joined by spaces, dim, then `▸` and
the current tool in the `claude` color while one runs. Hidden by the `t`
hotkey (`showTools`). Cards view is only offered from 44 body columns; below
that the `v` button is omitted and the tree is drawn.

### Messages section

Below the nodes, when `messages` is non-empty and `showMessages` is true:

```
messages
  review diff → main          2  "done, three callers found…"
  main → review diff          1  "stop after this file"
```

Sorted by `lastAt` descending, capped at 12 rows. Sender and receiver use the
node label, truncated to 18 columns each. The quote is dropped below 60
columns. `m` toggles the section.

### Footer

One row of `Button`s with hotkeys, drawn without chrome (`v: cards`,
`m: messages`, `t: tools`), active only while the pane holds the focus
(click or ctrl+x tab). Presses update the view flags in `$.state`, which
redraws the pane. A dim count on the right: `3 agents · 1 running`.

### Empty state

`No agents yet. The pane fills when the session spawns one.` in dim text.

## Commands

`/dag` is registered in `session.start`. A `command.run` hook on
`{ command: 'dag' }` reads `e.args`:

- (none): toggle the pane. Open if closed (an asked open places at any
  width; also clears `isClosedByPerson`); close if open.
- `inspect`: answer `{ text }` with the tree view rendered as plain text at
  80 columns, plus the messages section, so it lands in the transcript and can
  be copied or pasted into an issue.
- `reset`: clear the model to a fresh `main` and answer `{ text: 'Agent graph reset.' }`.
- anything else: answer a one-line usage text.

## Error handling

- Hooks on gating events (`agent.spawn`, `tool.call`, `session.send`,
  `command.run`) never return without `next` except `command.run` for our own
  command. Each is registered with `.catch(($, e, next) => next(e))`
  so a failure in our bookkeeping is skipped and the event proceeds untouched.
- The `ui.render` hook wraps drawing in a try; on failure it returns a
  single dim row `agent-dag: draw failed (<message>)` instead of throwing, so
  the engine's own fallback is never needed and the pane stays informative.
- A `$.agent.list()` rejection in the tick is ignored until the next tick.
- Unknown node ids (an event for an agent we never saw spawn, such as a
  forked skill) create the node on the fly at `turn.start` (status `running`,
  label `agent`, parent `main`); the next reconcile fills its label, type and
  parent from `$.agent.list()`. A spawn whose bookkeeping lands after the
  agent's first `turn.start` keeps the running status, clock and tool.
- `$.state` writes go through `update($, atom, fn)` with a functional update,
  so concurrent events do not clobber each other.

## Configuration (`userConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `glyphs` | string, options `unicode`, `ascii` | `unicode` | Glyph set for status and connectors. |
| `autoOpen` | boolean | `true` | Open the pane on the first spawn. |
| `defaultView` | string, options `tree`, `cards` | `tree` | View on first open. |

## Testing

`hooks/agent-dag.test.ts`, run by `claude plugin test <mod folder>`:

1. Reducer: spawn, turn.start, tool.call, turn.complete sequence yields a
   node with the right parent, status `completed`, `toolCount 1`, token sums,
   `currentTool` cleared.
2. Reducer: teammate's `answer` ends `idle`; `aborted` ends `killed`; `error`
   ends `failed`; a `deny` spawn result adds no node.
3. Reducer: two `session.send` from an agent to `main` yield one edge with
   `count 2`; a send to a `name` resolves to the node id.
4. Layout: tree rows at 100, 70, 56, 44 and 36 columns drop columns in the
   specified order and never truncate the label below 12.
5. Layout: ASCII glyph set contains no non-ASCII character.
6. Render: mount the pane on `terminal` and `desktop`; rows contain the
   labels; pressing `v` switches to cards and the tree validates; pressing
   `m` hides the messages section.
7. Command: `/dag inspect` answers text containing every label; `/dag reset`
   empties the nodes but keeps `main`.
8. Auto-open: the first spawn opens the pane; after a person close, a later
   spawn does not reopen it; `/dag` does.

Also: `claude plugin validate` clean, and `tsc -p` clean against the types
the engine lays beside the mod.

## Ghostty and terminal notes

- Ghostty draws U+2500–U+257F box drawing and U+25xx geometric shapes used
  here (`◐ ○ ● ◌ ▸`) from its built-in or font glyphs; `✓ ✗ ⊘` come from
  the font. The `ascii` option covers a font without them.
- Nothing in the mod reads `TERM`, writes escape sequences, or assumes a
  shell: the shell (zsh, bash, fish) is irrelevant to a mod.
- Mouse: pane focus by click and hotkeys are engine features; Ghostty's
  mouse reporting works with Claude Code's fullscreen TUI as with any pane.

## Sharing

Once it works, the mod can be copied out of the session's dev-mods folder to
a folder the person keeps and shared through a GitHub marketplace file, so
others install it with `/plugin install agent-dag --marketplace <owner>/<repo>`.
That step is separate and happens only when asked.
