---
name: session-coordination
description: Coordinate Claude and Codex agent sessions in tmux with the dag CLI. Create or bind sessions, exchange recorded messages, inspect inboxes, and view the shared card/tree dashboard. Use for cross-session agent collaboration.
---

Use the shell command `dag` for cross-session coordination. Run `dag --help` for
the installed command interface. The CLI companion must be installed separately
from this plugin; if missing, report that requirement rather than falling back
silently to unrecorded `tmux send-keys`.

Create a detached session and launch an agent with an explicit command, e.g.
`dag create reviewer --cwd /path/to/repo --role review -- claude`.
Choose the agent executable and starting prompt to fit the user's task.
Creating a session does not automatically delegate a task: include the task in
the executable's prompt arguments, or send it after the receiver is ready.
Commands after `--` are argv, not a shell expression.

For Codex, use `dag create reviewer --adapter codex --cwd /path/to/repo -- codex`.
Launching a command named `codex` also selects this adapter automatically.
It starts a private local App Server, creates and binds the exact thread ID,
adds coordination context without a model turn, and opens the native Codex TUI.
An initial quoted prompt after Codex options starts the task normally. Existing
approval and sandbox settings remain in effect. Managed mode accepts common
interactive options such as `-m`, `-c`, `--sandbox`, and `--add-dir`; use
`--adapter tmux` for raw Codex subcommands, profiles, or worktrees.

For an existing Codex pane, register it and then run `dag bind NAME` from a Codex
shell tool, where `CODEX_THREAD_ID` identifies the actual thread. An operator can
instead supply `dag bind NAME --thread ID --codex-socket PATH`. Bindings validate
the exact ID and working directory; never guess a thread from its title, newest
timestamp, or a parent's thread environment.

New sessions inherit `dag` on PATH, `DAG_HOME`, and their stable
`DAG_SESSION_ID`. A registered caller becomes the new session's parent. Use
`--parent none` for an independent root. Register an existing pane with
`dag register NAME` from inside it, or `dag register NAME --target %PANE`.
Use `dag sessions --json` to discover names, IDs, pane liveness, reported
readiness, and queued message counts.

Prefer `dag send NAME 'message' --key UNIQUE_REQUEST_KEY` over direct tmux
input. Reuse the same key and payload when retrying the same send. A key is
scoped to the sender/receiver pair; using it for different content is an error.
Use `--file PATH` for text whose quoting is awkward. Link to files or commits
instead of pasting large transcripts. Replies can include `--reply-to ID`.

Delivery depends on the adapter:

- Bound Codex sessions receive messages through `codex queue` immediately. The
  runtime decides when to execute them. `submitted` confirms queue acceptance,
  not receipt or completion. `dag busy` pauses DAG delivery; `dag ready` resumes
  and drains it. Do not call tmux `send-keys` as a fallback for a native error.
- Other sessions use explicit terminal readiness. No hook automatically detects
  their input prompt. `dag ready` permits one queued or future injection, then
  changes readiness to busy; `dag busy` revokes it.

- While working, poll `dag inbox --json`, acknowledge messages with
  `dag ack ID`, and handle their contents in the current turn. This consumes a
  queued message without injecting a new prompt.
- For terminal delivery, use `dag ready` only when the terminal can accept the
  next prompt. Do not mark an arbitrary shell or a pane
  with an approval dialog ready for agent prompts.
- `injected` means tmux accepted the input. `acknowledged` means the receiving
  agent confirmed receipt, not that the requested work finished. Send a reply
  with the result or artifact reference when work is complete.
- If delivery is `sending` after a crash or `uncertain` after a transport error,
  inspect the receiving terminal and inbox. Do not blindly replay it. Read and
  acknowledge the durable inbox entry before accepting another prompt.

Availability is separate from ready/busy and runtime activity. On a usage limit,
use `dag pause NAME --reason 'Usage limit reached'` if no automatic observation
is available. `--until ISO_TIMESTAMP_WITH_TIMEZONE` records an expected reset,
not an automatic retry. New messages stay queued; `dag send` returns the
receiver's availability and reason. Check `dag sessions --json` and the inbox.
Managed Codex observes structured root-thread limit errors; Claude's plugin
command hooks observe `StopFailure.error`. A native client can continue its
existing task on its own; never resend submitted/injected messages merely
because a limit reset. Do not inject prompts into Claude's usage-limit wait,
since new input can end the wait. After verifying recovery, use `dag resume NAME`
to release new DAG messages. This preserves readiness and never replays messages;
tmux still requires `dag ready` when it can accept input. Unconfirmed sending or
uncertain deliveries must be inspected and acknowledged before resume. Neither
idle telemetry nor ready/bind clears an availability hold.

Use `dag attach NAME` to focus a session. For an offline session restarted in a
new pane, `dag register NAME --target %PANE --replace` preserves its stable ID
and inbox, and resets readiness to unknown. A replaced terminal loses its old
Codex thread binding; bind the new process before native delivery. Never replace
an active session.

When a registration is no longer needed, use `dag unregister NAME` (or omit NAME
for the current session). Use `dag unregister --offline` to remove all offline
records. This releases names and pane bindings and removes telemetry without
stopping agent processes. Message history is retained, remaining children become
roots, and reusing a name creates a new identity with an empty inbox. Keep an
offline registration if you intend to reconnect it with `register --replace`.

`dag view` opens the shared card/tree dashboard; `dag view --pane` puts it in a
separate tmux pane. `v` changes density, `m` toggles messages, `t` toggles tools,
arrow keys scroll, and `q` closes the viewer. `dag view --once --json` returns a
snapshot. Managed Codex sessions stream model, turn, tool, token and child-agent
events even when the viewer is closed. Existing bound threads are observed while
the viewer is open. Counters describe observed events; historical tools and turns
are not backfilled. Claude's detailed internal telemetry remains in its `/dag`
pane; the standalone view shows its registered session and recorded DAG messages.

The registry tracks sessions and messages; it does not synchronize code, create
git worktrees, grant extra execution permissions, or automatically run tasks.
