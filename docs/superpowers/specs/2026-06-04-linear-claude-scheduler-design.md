# Linear → Claude Code Scheduler — Design Spec

**Date:** 2026-06-04
**Status:** Approved for planning

## Purpose

An autonomous scheduler that turns the **Todo** column of configured Linear projects into a work queue for local Claude Code agents. Every N minutes it checks Linear for Todo issues, picks one, runs `claude` headlessly in the matching local git workspace to implement and test the work, pushes the result, and moves the ticket to **In Review**.

Single-user, single-machine (macOS), personal tool.

## Decisions Made

| Question | Decision |
|---|---|
| Linear auth | Personal API key in `.env` (`LINEAR_API_KEY`), via `@linear/sdk` |
| Concurrency | One ticket at a time, globally, enforced by a PID lockfile |
| Git workflow | Configurable per project: `branch-pr`, `branch-push`, `main-push` |
| Claude permissions | `claude -p` with `--dangerously-skip-permissions` (trusted local repos; branch-based flow is the safety net) |
| Failure handling | Comment on ticket with error summary + log tail, move back to Todo, skip until the ticket is updated in Linear |
| Execution model | Cron-style one-shot tick, triggered by **launchd** (`StartInterval`); optional `--loop` foreground mode |
| Runtime | Node.js + TypeScript, vitest for tests |

## Architecture

One-shot "tick" process. launchd fires it every `pollIntervalMinutes`; each run does at most one ticket's worth of work and exits.

```
launchd (StartInterval) ──▶ node dist/index.js
                              │
                              ├─ lockfile held by a live process? → exit 0 (silent)
                              ├─ acquire lock (write PID)
                              ├─ recover: ticket stuck In Progress from a dead run?
                              │    → comment "interrupted", move back to Todo
                              ├─ poll Linear for Todo issues in configured projects
                              ├─ no eligible ticket? → release lock, exit 0
                              ├─ claim ticket → run Claude → verify → finalize
                              └─ release lock, exit
```

### Modules

```
src/
  index.ts     — entrypoint: CLI args (--loop, --once default), tick orchestration
  config.ts    — load + validate config.json and .env; fail fast with clear errors
  linear.ts    — Linear API wrapper: fetch Todo issues, move status, post comments
  lock.ts      — PID lockfile: acquire/release, stale-lock detection (is PID alive?)
  state.ts     — .state.json: failed-ticket skip list, active-ticket record
  prompt.ts    — build the Claude prompt from ticket data + git-flow instructions
  runner.ts    — spawn claude CLI in workspace cwd, stream output to log, timeout
  verify.ts    — post-run checks: branch pushed to remote, PR exists (if branch-pr)
logs/          — one file per run: <IDENTIFIER>-<timestamp>.log
```

Each module has one purpose and is unit-testable with mocks; `index.ts` only wires them together.

## Configuration

### `config.json` (user-edited, committed as `config.example.json`, real one gitignored)

```json
{
  "pollIntervalMinutes": 2,
  "claude": {
    "command": "claude",
    "timeoutMinutes": 60
  },
  "statuses": {
    "todo": "Todo",
    "inProgress": "In Progress",
    "inReview": "In Review"
  },
  "projects": [
    {
      "linearProject": "Kibadist Knowledge",
      "path": "/Users/kibadist/Code/kibadist-knowledge",
      "gitFlow": "branch-pr",
      "baseBranch": "main"
    },
    {
      "linearProject": "Detailing App",
      "path": "/Users/kibadist/Code/detailingApp/detailing-app",
      "gitFlow": "branch-push",
      "baseBranch": "main"
    }
  ]
}
```

- `linearProject` — Linear project name (matched case-insensitively; validated against the API on startup).
- `path` — absolute path to the local git workspace; must exist and be a git repo.
- `gitFlow` — `branch-pr` (branch + push + `gh pr create`), `branch-push` (branch + push only), `main-push` (commit straight to `baseBranch` and push).
- `statuses` — workflow state **names** in Linear; resolved to state IDs per team at runtime.
- Startup validation errors are specific: missing path, unknown project name, bad enum value, missing API key.

### `.env` (gitignored)

```
LINEAR_API_KEY=lin_api_...
```

## Ticket lifecycle

1. **Select.** Query Linear for issues in `statuses.todo` belonging to configured projects. Filter out tickets on the skip list (failed before and not updated since). Order: priority (urgent→low), then oldest `createdAt`. Take the first.
2. **Claim.** Move to `statuses.inProgress`. Record in `.state.json` as active (issue id, identifier, PID, started-at).
3. **Prompt.** Build from: identifier, title, description, all comments, plus instructions:
   - implement the task; run the project's tests and make them pass
   - follow the configured git flow (branch name `claude/<identifier>-<slug>` for branch flows)
   - push; for `branch-pr`, open a PR with `gh pr create` and reference the ticket
4. **Run.** Spawn `claude -p <prompt> --dangerously-skip-permissions` with `cwd` = project path. Stream stdout/stderr to the run's log file. Kill on timeout.
5. **Verify.** Independently of Claude's claims:
   - branch flows: the expected branch exists on the remote (`git ls-remote`)
   - `main-push`: remote `baseBranch` HEAD moved beyond its pre-run SHA
   - `branch-pr`: a PR for the branch exists (`gh pr view`)
6. **Finalize — success.** Move ticket to `statuses.inReview`. Comment with branch name, PR link (if any), and a short summary of Claude's final output. Clear active state.
7. **Finalize — failure** (timeout, non-zero exit, verification failed). Comment with what failed plus the last ~30 lines of the log. Move back to `statuses.todo`. Add to skip list, recording the ticket's `updatedAt` **re-fetched after our own comment/status mutations** (otherwise our own writes would immediately mark it as "touched"). The ticket becomes eligible again only when its `updatedAt` is newer than the recorded value — i.e. you edited or commented on it after the failure.

## Error handling

| Failure | Behavior |
|---|---|
| Concurrent run | Lockfile PID alive → exit 0 silently |
| Stale lock (crash/reboot) | PID dead → take over lock; if `.state.json` has an active ticket, comment "run was interrupted" and move it back to Todo before proceeding |
| Linear API unreachable | Log and exit; next tick retries. Never leaves the lock held |
| Claude timeout | SIGTERM then SIGKILL, failure flow |
| Claude exits 0 but push verification fails | Failure flow — honest comment that the work was not pushed |
| Config invalid | Exit non-zero with a specific message; nothing touched in Linear |

All Linear mutations happen around the Claude run, never mid-run, so a crash can at worst leave one ticket In Progress — which the stale-lock recovery fixes on the next tick.

## launchd integration

Repo ships `launchd/com.kibadist.claude-scheduler.plist` (generated with absolute paths) plus `Makefile`/npm scripts:

- `npm run install-agent` — copy plist to `~/Library/LaunchAgents/`, `launchctl bootstrap`
- `npm run uninstall-agent` — `launchctl bootout`, remove plist
- Plist sets: `StartInterval` (from config), `WorkingDirectory`, `StandardOutPath`/`StandardErrorPath` → `logs/launchd.log`, and a `PATH` that includes the directories for `node`, `claude`, `gh`, `git`

`--loop` mode: same tick in a `while` loop with the configured interval, for watching live in a terminal. Lockfile makes the two modes mutually safe.

## Testing

- **Unit (vitest):** config validation (good/bad fixtures), prompt building per git flow, skip-list eligibility logic, stale-lock detection.
- **Integration:** full tick with a **stub `claude` executable** (shell script that writes a marker commit/branch, exits 0/1/never per scenario) and a **mocked Linear client**. Scenarios: happy path → In Review; Claude fails → comment + Todo + skip list; timeout; verification failure; concurrent-run exit; stale-lock recovery.
- No real Linear API or real tokens in any test.

## Out of scope (YAGNI)

- Web dashboard / status UI
- Parallel ticket processing
- Webhooks
- Multi-user / team auth (OAuth)
- Automatic retries (a failed ticket waits for human touch)
