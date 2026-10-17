# agent-dag

Local coordination for independent agent sessions in tmux.

Create and register sessions, send recorded messages, and follow their status
from one terminal. Each session has a stable identity and inbox, so agents can
find each other by name and preserve pending messages across reconnections.

The `dag` CLI works with agent processes launched in tmux. Its Codex adapter
provides native message delivery and live runtime telemetry. `dag view` renders
the shared card/tree dashboard in a terminal or a separate tmux pane. A Claude
Code plugin adds a live view of the agents running inside a single session and a skill for
using the CLI. The CLI can be used on its own.

```
$ dag sessions
SESSION                  STATUS    QUEUED  PANE    ADAPTER  ACTIVITY   ROLE
builder                  busy      0       %1      tmux     -          implementation
  reviewer               ready     0       %2      codex    running    review
  tester                 busy      2       %3      tmux     -          tests
```

`dag` coordinates tmux sessions. `/dag` controls the agent tree inside a Claude
Code session.

## Install the CLI

Requires Node.js 20+ and tmux.

```sh
git clone https://github.com/Qifei-C/agent-dag.git
cd agent-dag
npm install
npm run install:cli
dag --help
```

The installer links `~/.local/bin/dag` to this checkout without replacing an
existing command. Keep the checkout in place. You can also run `./bin/dag`
directly or choose a bin directory with `npm run install:cli -- /path/to/bin`.
If needed, add `~/.local/bin` to your shell's `PATH`. Installing the Claude Code
plugin alone does not install the CLI.

## Create and register sessions

Create and register an independent agent session:

```sh
dag create reviewer --cwd /path/to/repo --role review -- claude
dag sessions
dag attach reviewer
```

The session starts detached. Without a command after `--`, it starts your shell.
The launched process inherits `dag` on PATH, `DAG_HOME`, and a unique
`DAG_SESSION_ID`. A registered caller becomes its parent; `--parent none`
starts another root. The parent Claude nesting marker is cleared for the new,
independent process. Other agent executables can also be passed after `--`.
Command arguments are passed directly, without shell evaluation; use an explicit
shell command only when you intend shell syntax. Include a starting task in the
agent's command arguments, or use the inbox workflow below.

Register sessions that already exist:

```sh
dag register builder --role implementation              # inside its tmux pane
dag register reviewer --target %3 --role review         # explicit pane
```

Session names are unique across the registry. Registration is idempotent for the
same name and pane. `dag register NAME --target %PANE --replace` moves an offline
session to a new pane, preserving its ID and inbox. Readiness resets to unknown.
Pane bindings and server sockets are checked before injection, including after
tmux server restarts, so a recycled pane ID is not sufficient to receive input.

## Codex adapter

Tested with Codex CLI 0.163.0. Requires native `codex queue` and App Server Unix
socket support, plus the normal Codex sign-in/provider setup.

```sh
dag create coder --adapter codex --cwd /path/to/project --role implementation -- codex
dag send coder 'Inspect the current diff and report findings' --key review-42
dag view --pane
```

The adapter starts a private local App Server, creates the thread, persists its
coordination context without inference, binds its exact ID, and opens the native
Codex TUI. It preserves normal Codex approval and sandbox settings. Closing the
session also shuts down its private server. A command named `codex` selects this
adapter automatically; `dag create coder --adapter codex` uses the default Codex
executable. Pass a quoted initial prompt after Codex options to start a task.
The managed session stays bound to that thread. To work in another thread, create
another DAG session rather than switching the managed TUI with `/new` or `/fork`.

Codex messages use the native queue, including while a turn is active. They do
not use terminal key injection or require `dag ready` for each message.
`submitted` means Codex accepted the message into its queue; the receiving agent
still uses `dag ack ID` to acknowledge receipt. `dag busy coder` pauses DAG
delivery, and `dag ready coder` resumes and drains it. An uncertain submission is
never automatically retried or sent through a tmux fallback.

When an agent invokes `dag` through a Codex shell tool, its sandbox policy still
applies to registry files and local sockets. Use normal Codex approvals for any
required access; the adapter does not broaden execution permissions.

Common interactive options such as `-m`, `-c`, `--sandbox`, and `--add-dir` pass
through to Codex. Managed mode owns the App Server, directory and thread, so raw
subcommands, `--remote`, profiles, and managed worktrees are rejected explicitly.
Use `--adapter tmux` when you want to run those commands directly instead.

For an existing Codex pane, run these from a Codex shell tool:

```sh
dag register coder
dag bind coder
```

`bind` reads `CODEX_THREAD_ID` inside Codex. From another shell, supply the exact
ID and, if needed, `--codex-socket PATH` and `--codex-bin PATH`. Binding checks the
thread ID and working directory, and rejects an ID already bound elsewhere.
`DAG_CODEX_SOCKET` overrides the default local control socket, and `DAG_CODEX_BIN`
selects the executable for new managed sessions. A replaced offline pane loses
its old thread binding before it can receive native messages.

The Codex plugin compatibility manifest packages the shared coordination skill
without loading Claude's function hooks. To install it from this checkout:

```sh
codex plugin marketplace add /path/to/agent-dag
codex plugin add agent-dag@qifei-c
```

Installing the skill is optional for managed startup: the new thread also gets a
reference to its coordination guide. CLI installation and dependencies are still
required on the machine that runs the agents.

## Send and receive messages

Messages are durable and queued by default:

```sh
dag send reviewer 'Please review the current diff' --from builder --key review-42
dag inbox reviewer --json
dag ack MESSAGE_ID --session reviewer
dag send builder 'Review finished; see commit abc123' --from reviewer --reply-to MESSAGE_ID
dag messages
```

Inside a registered agent session, sender and inbox identity are inferred;
`--from` and `--session` are useful for operator commands. Without a registered
sender, messages are recorded as from `person`. `--key` deduplicates retries for
the same sender, receiver, and payload. `--file PATH` reads message text from a
file (maximum 16 KiB). Inbox polling plus acknowledgement handles queued messages
in an agent's current turn without writing to its terminal.

For terminal-based delivery through the tmux adapter:

```sh
dag ready reviewer
dag sessions --watch
```

Only mark a pane ready when its agent can accept input. Readiness is explicitly
reported; this release does not detect busy agents, prompt boundaries, or approval
dialogs automatically. One readiness declaration permits one injection, then
returns to busy. `dag busy NAME` revokes readiness. Message text is sent as a
single JSON-escaped line with a message ID and acknowledgement instruction.
`injected` means the input was written; `acknowledged` confirms receipt, not task
completion. Replies carry the actual result.

Interrupted sends remain `sending`, or become `uncertain` if a transport error
was observed. These are never replayed automatically. Inspect the terminal and
read the durable inbox entry, then acknowledge it before declaring readiness
again. If an acknowledged message still needs action, handle its content in the
current turn. Offline receivers retain their queued messages.

## Session overview and storage

`dag sessions` renders the parent/child session tree with delivery status,
liveness, queued counts, pane IDs, adapters, runtime activity, and roles.
`STATUS` is delivery readiness; `ACTIVITY` is observed Codex runtime state.
`--watch` refreshes it every two seconds;
`--json` is available on data commands. The plugin's `session-coordination` skill
documents the agent workflow. To load the skill from a checkout, launch Claude
with that checkout, for example
`dag create reviewer -- claude --plugin-dir /path/to/agent-dag`.
Codex model, turn, tool, token and child-agent events are collected for managed
sessions even when the dashboard is closed. Historical turn/tool counts are not
backfilled; token updates are cumulative snapshots and cached tokens are not
added twice. Existing bound Codex threads are observed while the dashboard is
open, using a `thread/resume` subscription without configuration overrides.
Claude's internal tool/token telemetry remains in its embedded pane. The shared
dashboard shows its registered session and DAG messages. Task scheduling remains
manual.

```sh
dag view                       # interactive card/tree dashboard
dag view --pane                # open a separate tmux pane
dag view --once                 # print a snapshot
dag view --once --json          # read the graph as JSON
```

In the dashboard, `v` switches density, `m` toggles messages, `t` toggles tool
details, arrow keys scroll, and `q` exits. Native Codex permissions and questions
remain in its own TUI; the observer does not approve requests. Offline panes and
unavailable telemetry are marked explicitly.

State lives in `~/.local/state/agent-dag/state.json`. All participating sessions
must use the same `DAG_HOME` (or `--home DIR`). Writes are atomic and serialized
across CLI processes. State files are private to the local user and contain full
message text. Use `DAG_TMUX_SOCKET` or `--socket PATH` for creation/registration
on another local tmux server; each registered session keeps its resolved socket.
The registry needs no shared coordinator daemon. Managed Codex sessions own
private App Servers on local Unix sockets. Server logs are private files under
`DAG_HOME/codex-SESSION_ID.log`. If a process dies holding the registry
lock, dead owners are recovered. A crash between creating the lock directory and
writing its owner can leave an empty `DAG_HOME/lock`; remove that empty directory
with `rmdir` if no CLI operation is running.

## Command reference

Core CLI commands:

| Command | Purpose |
| --- | --- |
| `dag create NAME -- COMMAND` | Create and register a detached tmux session. |
| `dag register NAME` | Register the current tmux pane. |
| `dag bind [NAME]` | Bind a registered pane to its exact Codex thread. |
| `dag send NAME TEXT` | Queue a message for a registered session. |
| `dag inbox [NAME]` | Read messages for the current or named session. |
| `dag ack ID` | Confirm receipt in the current session. |
| `dag ready [NAME]` | Permit one queued or future terminal injection. |
| `dag busy [NAME]` | Queue messages without injecting terminal input. |
| `dag messages` | Show the complete message history. |
| `dag sessions --watch` | Follow session status and queued counts. |
| `dag view [--pane]` | Open the shared card/tree dashboard. |
| `dag attach NAME` | Focus a registered session's pane. |

Run `dag --help` for command arguments. For an agent workflow, see the
[session-coordination skill](skills/session-coordination/SKILL.md).

## Claude Code plugin

The plugin connects agent detail cards with tree branches in a docked pane.
Follow the parent/child rails to see who spawned whom, then read each card for
status, model, elapsed time, turns, total and input/output tokens, tool counts,
current tool, recent tools, and the latest message. Long task names and metadata
wrap onto additional lines. The pane uses Claude Code's renderer in supported
terminals, including tmux.

```
╭─ ◐ main ─────────────────────────────────────────────────────────────╮
│ running · ? · 32s · 1 turn                                           │
│ tokens 0 · in 0 · out 0 · 0 tools                                    │
│ msg 0 sent / 1 received                                              │
│ ← review session coordination: "Found two delivery edge cases;       │
│ checking recovery."                                                  │
╰──────────────────────────────────────────────────────────────────────╯
├─╭─ ◐ fork: review session coordination ──────────────────────────────╮
│ │ running · sonnet · 31s · 1 turn                                    │
│ │ tokens 8.0k · in 7.2k · out 800 · 3 tools                          │
│ │ now ▸ Bash                                                         │
│ │ recent Read → Grep → Read                                          │
│ │ msg 1 sent / 0 received                                            │
│ │ → main: "Found two delivery edge cases; checking recovery."        │
│ ╰────────────────────────────────────────────────────────────────────╯
│ └─╭─ ◌ Explore: 检查消息队列与重试逻辑 👩‍💻 ───────────────────────────╮
│   │ pending · haiku · 31s · 0 turns                                  │
│   │ tokens 0 · in 0 · out 0 · 0 tools                                │
│   ╰──────────────────────────────────────────────────────────────────╯
└─╭─ ✗ run integration tests ──────────────────────────────────────────╮
  │ failed · sonnet · 12s · 0 turns                                    │
  │ tokens 2.2k · in 2.0k · out 200 · 0 tools                          │
  ╰────────────────────────────────────────────────────────────────────╯
```

### Use the pane

- The pane opens by itself the first time the session spawns an agent. The
  engine only seats an unasked pane on a wide terminal (144 columns, or 110
  once you have opened it by hand); narrower than that it waits until you
  run `/dag`, which seats it at any width.
- `/dag` opens or closes the pane. `/dag inspect` prints the current layout into the
  transcript. `/dag reset` clears it.
- With the pane focused (click it, or ctrl+x then tab): `v` switches between
  detailed cards and a compact tree with one row per agent. `m` toggles inline
  messages and the messages section; `t` toggles current/recent tool details.
  Arrow keys scroll.
- Below 36 body columns, the pane automatically uses the compact layout. It
  restores the selected density when widened. Deep branches shorten their
  ancestor gutter to preserve room for card content. Chinese text and joined
  emoji are measured in terminal cells so card borders stay aligned.

### Options (`/config`)

The tokens column counts every input token (uncached, cache reads and cache
writes) plus output, since Claude Code agents run mostly on cached input.

| Option | Values | Default |
| --- | --- | --- |
| Glyph set | `unicode`, `ascii` | `unicode` |
| Open on first agent | on, off | on |
| Default density | `detailed`, `compact` | `detailed` |

Pick `ascii` if your font lacks `✓ ✗ ⊘ ◐`.
ASCII mode also applies to card borders, branches, and message/tool arrows.
Saved `tree` and `cards` preferences are still read as compact and detailed
respectively; an existing session keeps its selected density across hot reloads.

### Install the plugin

At the prompt of a Claude Code terminal session:

```
/plugin install agent-dag --marketplace qifei-c/agent-dag
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it
for every session).

From a shell:

```
claude plugin marketplace add qifei-c/agent-dag
claude plugin install agent-dag@qifei-c
```

To run a checkout without installing: `claude --plugin-dir /path/to/agent-dag`.

## Develop

```
npm run check
npm test
claude plugin validate .
claude plugin test .
```

CLI tests use real processes, temporary isolated tmux servers and a local Codex
protocol fixture; they never send input to existing sessions or invoke a real
model. Run them in an environment that permits local Unix sockets and
pseudo-terminals. `npm install` builds the shared renderer; after changing the
layout, run `npm run build` (also run automatically before CLI tests).

`hooks/model.ts` is the pure reducer, `hooks/draw.ts` the pure layout,
`hooks/register.tsx` the only file that talks to the engine. `cli/` is the
standalone companion; it does not run in the plugin's restricted hook runtime.
`cli/layout-entry.ts` bundles the same pure renderer for `dag view`.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [plugin packaging](https://developers.openai.com/plugins/build/plugins).
