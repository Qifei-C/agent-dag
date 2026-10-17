---
name: session-coordination
description: Create and register independent agent sessions in tmux, send recorded cross-session messages, and inspect their inboxes using the dag CLI. Use for collaboration across tmux sessions; the in-session agent tree remains available through /dag.
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

Session readiness is explicit; no hook automatically detects the agent's prompt:

- While working, poll `dag inbox --json`, acknowledge messages with
  `dag ack ID`, and handle their contents in the current turn. This consumes a
  queued message without injecting a new prompt.
- Use `dag ready` only when the terminal can accept the next prompt. It permits
  one queued or future injection, then automatically changes readiness to busy.
  `dag busy` cancels that readiness. Do not mark an arbitrary shell or a pane
  with an approval dialog ready for agent prompts.
- `injected` means tmux accepted the input. `acknowledged` means the receiving
  agent confirmed receipt, not that the requested work finished. Send a reply
  with the result or artifact reference when work is complete.
- If delivery is `sending` after a crash or `uncertain` after a transport error,
  inspect the receiving terminal and inbox. Do not blindly replay it. Read and
  acknowledge the durable inbox entry before accepting another prompt.

Use `dag attach NAME` to focus a session. For an offline session restarted in a
new pane, `dag register NAME --target %PANE --replace` preserves its stable ID
and inbox, and resets readiness to unknown. Never replace an active session.

The registry tracks sessions and messages; it does not synchronize code, create
git worktrees, grant extra execution permissions, or automatically run tasks.
