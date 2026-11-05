# agent-dag web dashboard

A read-only browser overview of long-running tmux agents and a report writer they
use to publish their status. It extends the native CLI and Claude plugin and has no
npm dependencies. `snapshot.py` needs `/usr/bin/python3` with PyYAML.

## Run

```sh
RESEARCH_ROOT=/path/to/project node web/server.mjs
```

| Variable | Default | Purpose |
|---|---|---|
| `RESEARCH_ROOT` | required | Project directory to read metadata and evidence from |
| `DAG_WEB_PROJECT` | directory name | Project label in the page |
| `DAG_WEB_AGENTS` | every session | Comma-separated names to show and accept reports from |
| `DAG_WEB_COORDINATOR` | none | Agent that also lists `reports/handoffs` |
| `DAG_WEB_HOST` | `127.0.0.1` | Listen address |
| `DAG_WEB_PORT` | `8766` | Listen port |
| `DAG_WEB_ALLOWED_HOSTS` | none | Extra accepted `Host` names, comma-separated |

Access control is the network you bind to. There is no login, so do not bind a public
address.

## Data sources

- Identity, coordination and queues: the native `state.json`, through Service and Store.
- Activity: read-only `tmux capture-pane`. A prompt does not prove background work has
  ended, and ready/busy is delivery permission, not work status.
- Tasks, validation and dependencies: self-reports at `$DAG_HOME/reports/<agent>.json`.
  Reports older than 15 minutes are flagged as stale, never rewritten.
- Project state: `research-state.yaml` in `RESEARCH_ROOT`, with its observation time.
- Evidence: text files under `reports/agents`, `reports/handoffs`, `reports/reviews` and
  `dashboard`. Real paths are resolved so symlinks cannot escape, and content is shown
  as text, never executed as HTML.

The page polls every 5 seconds, keeps its last snapshot when disconnected and marks
stale data. It has no write endpoints, remote CDNs or third-party tracking. Common
credential formats are masked, but do not put secrets in reports.

## Reporting from an agent

Report at natural checkpoints: on switching task, waiting, blocking, delivering or after
review.

```sh
cat > /tmp/worker-report.json <<'JSON'
{
  "agent": "worker",
  "status": "waiting",
  "task": "Audit the latest run",
  "summary": "Audit is ready and waiting for the run's raw output.",
  "validation": [{"name": "Output matches the controller log", "status": "pending"}],
  "dependsOn": ["coordinator"],
  "blockers": ["Raw output not available yet"],
  "evidence": ["reports/agents/worker/audit.md"]
}
JSON
node web/report.mjs --file /tmp/worker-report.json
```

Task statuses are working, waiting, blocked, review and complete. Validation statuses are
pending, running, pass, fail, unknown and draft. A `pass` should cite evidence. See the
[session coordination skill](../skills/session-coordination/SKILL.md) for messaging.

## Test

```sh
node --test web/browser.test.mjs
```
