# agent-dag

A Claude Code mod that shows the session's agents as a live tree in a docked
pane: who spawned whom, status, elapsed time, tokens, model, the tool running
now, and which agents have messaged each other. Our own take on dsh-task-dag
and zoetrope, drawn by Claude Code itself, so it works in any terminal that
runs Claude Code's fullscreen TUI (Ghostty, kitty, iTerm2, Terminal.app,
GNOME Terminal, tmux) under any shell.

The optional `dag` CLI companion adds a shared registry and recorded messaging
for independent tmux sessions. The Claude pane shows the local agent tree;
`dag sessions --watch` shows the cross-session overview.

```
◐ main                           running  1m02s   12.4k  fable   Agent
├─✓ Explore: find callers        done       12s    4.1k  haiku
├─◐ fork: review diff            running    31s    8.0k  fable   Bash
│ └─◌ Plan: outline fix          pending     4s       0  sonnet
└─✗ run tests                    failed     40s    2.2k  sonnet

messages
  review diff → main       1  "done, three callers found"
```

## Coordinate tmux sessions

Requires Node.js 20+ and tmux. From this checkout:

```sh
npm run install:cli
dag --help
```

The installer links `~/.local/bin/dag` to this checkout without replacing an
existing command. Keep the checkout in place. You can also run `./bin/dag`
directly or choose a bin directory with `npm run install:cli -- /path/to/bin`.
Installing the Claude plugin alone does not install the shell command.

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

To accept a new prompt through tmux instead:

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

`dag sessions` renders the parent/child session tree with readiness, liveness,
queued counts, pane IDs, and roles. `--watch` refreshes it every two seconds;
`--json` is available on data commands. The plugin's `session-coordination` skill
documents the agent workflow. To use the new skill before publishing/updating
the installed plugin, launch Claude with this checkout, for example
`dag create reviewer -- claude --plugin-dir /path/to/agent-dag`.
Cross-session tool/token telemetry and automatic
task scheduling are not part of this release.

State lives in `~/.local/state/agent-dag/state.json`. All participating sessions
must use the same `DAG_HOME` (or `--home DIR`). Writes are atomic and serialized
across CLI processes. State files are private to the local user and contain full
message text. Use `DAG_TMUX_SOCKET` or `--socket PATH` for creation/registration
on another local tmux server; each registered session keeps its resolved socket.
No daemon or network service is needed. If a process dies holding the registry
lock, dead owners are recovered. A crash between creating the lock directory and
writing its owner can leave an empty `DAG_HOME/lock`; remove that empty directory
with `rmdir` if no CLI operation is running.

## Use the Claude pane

- The pane opens by itself the first time the session spawns an agent. The
  engine only seats an unasked pane on a wide terminal (144 columns, or 110
  once you have opened it by hand); narrower than that it waits until you
  run `/dag`, which seats it at any width.
- `/dag` opens or closes the pane. `/dag inspect` prints the tree into the
  transcript. `/dag reset` clears it.
- With the pane focused (click it, or ctrl+x then tab): `v` switches between
  the tree and the cards view, `m` folds the messages section, `t` hides the
  tool chips on cards. Arrow keys scroll.

## Options (`/config`)

The tokens column counts every input token (uncached, cache reads and cache
writes) plus output, since Claude Code agents run mostly on cached input.

| Option | Values | Default |
| --- | --- | --- |
| Glyph set | `unicode`, `ascii` | `unicode` |
| Open on first agent | on, off | on |
| Default view | `tree`, `cards` | `tree` |

Pick `ascii` if your font lacks `✓ ✗ ⊘ ◐`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-dag --marketplace qifei-c/agent-dag
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it
for every session). The mod is active at once; no restart.

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

CLI tests use real processes and temporary, isolated tmux servers; they never
send input to existing sessions. Run them in an environment that permits local
Unix sockets and pseudo-terminals.

`hooks/model.ts` is the pure reducer, `hooks/draw.ts` the pure layout,
`hooks/register.tsx` the only file that talks to the engine. `cli/` is the
standalone companion; it does not run in the plugin's restricted hook runtime.
