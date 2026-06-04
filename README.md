# cron-claude-scheduler

Turns the **Todo** column of your Linear projects into a work queue for local
Claude Code agents. Every few minutes it picks one Todo ticket, runs `claude`
headlessly in the mapped local git workspace, verifies the work was pushed,
and moves the ticket to **In Review** — or comments and moves it back to
**Todo** on failure.

## Setup

1. `npm install && npm run build`
2. `cp .env.example .env` and set `LINEAR_API_KEY`
   (Linear → Settings → Security & access → Personal API keys)
3. `cp config.example.json config.json` and map your Linear projects to local
   git workspaces (see below)
4. Test one tick by hand: `npm run tick`
5. Install the launchd agent: `npm run install-agent`

## config.json

| Field | Meaning |
|---|---|
| `pollIntervalMinutes` | How often launchd fires a tick (positive integer) |
| `claude.command` | The claude CLI binary (usually just `claude`) |
| `claude.timeoutMinutes` | Kill a run that exceeds this |
| `statuses.*` | Workflow state names in your Linear team |
| `projects[].linearProject` | Linear project name (case-insensitive) |
| `projects[].path` | Absolute path to the local git workspace |
| `projects[].gitFlow` | `branch-pr` \| `branch-push` \| `main-push` |
| `projects[].baseBranch` | Branch to start from / push to |

### gitFlow

- **branch-pr** — work on `claude/<ticket>-<slug>`, push, open a PR with `gh`
- **branch-push** — same branch, push, no PR
- **main-push** — commit directly to `baseBranch` and push

## Daily operation

- A failed ticket gets a 🤖 comment with the log tail and goes back to Todo.
  It is **skipped** until you edit or comment on it — your touch means
  "try again".
- One ticket runs at a time, machine-wide (PID lockfile).
- Per-run logs: `logs/<TICKET>-<timestamp>.log`; launchd output: `logs/launchd.log`.
- Watch live: `npm run loop` (safe alongside launchd — the lockfile prevents overlap).
- Uninstall: `npm run uninstall-agent`.

## How verification works

The scheduler never trusts Claude's word. After a run it checks the remote:
branch flows must show the branch on `origin` (`git ls-remote`), `branch-pr`
must also have a PR (`gh pr view`), and `main-push` must have advanced the
remote base branch. Anything else is reported as a failure on the ticket.
