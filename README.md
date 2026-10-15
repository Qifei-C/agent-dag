# agent-dag

A Claude Code mod that shows the session's agents as a live tree in a docked
pane: who spawned whom, status, elapsed time, tokens, model, the tool running
now, and which agents have messaged each other. Our own take on dsh-task-dag
and zoetrope, drawn by Claude Code itself, so it works in any terminal that
runs Claude Code's fullscreen TUI (Ghostty, kitty, iTerm2, Terminal.app,
GNOME Terminal, tmux) under any shell.

```
◐ main                           running  1m02s   12.4k  fable   Agent
├─✓ Explore: find callers        done       12s    4.1k  haiku
├─◐ fork: review diff            running    31s    8.0k  fable   Bash
│ └─◌ Plan: outline fix          pending     4s       0  sonnet
└─✗ run tests                    failed     40s    2.2k  sonnet

messages
  review diff → main       1  "done, three callers found"
```

## Use

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

From a terminal session's prompt, once this folder is published as a
marketplace (see the plugin-authoring skill's "Sharing a mod"):

```
/plugin install agent-dag --marketplace <owner>/<repo>
```

While developing: `claude --plugin-dir /path/to/agent-dag`.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/model.ts` is the pure reducer, `hooks/draw.ts` the pure layout,
`hooks/register.tsx` the only file that talks to the engine.
