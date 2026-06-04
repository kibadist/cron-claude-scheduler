# cron-claude-scheduler

**Turn your Linear Todo column into a work queue for autonomous Claude Code agents.**

Move a ticket to **Todo** in Linear → within minutes, a [Claude Code](https://claude.com/claude-code) agent picks it up, implements it in the right local git repository, runs the tests, pushes a branch, opens a pull request, and moves the ticket to **In Review** with the PR link. You review the PR and merge. That's the whole workflow.

```
┌─────────┐    poll     ┌───────────────┐   claude -p    ┌──────────────────┐
│ Linear  │ ──────────► │   scheduler   │ ─────────────► │ local git repo   │
│  Todo   │             │ (launchd tick │                │ implement + test │
└─────────┘             │  every N min) │                │ commit + push    │
     ▲                  └───────┬───────┘                └────────┬─────────┘
     │                          │ verify push really happened     │
     │   In Review + PR link    │ (git ls-remote / gh pr view)    ▼
     └──────────────────────────┴──────────────────────  GitHub branch + PR
```

## Why

If you already write well-scoped tickets, the remaining work of *starting* an agent — opening a terminal, cd-ing to the right repo, pasting the ticket, babysitting the run, updating the ticket — is pure overhead. This scheduler removes it. Linear becomes the only interface: tickets in, pull requests out.

Design principles:

- **Never trust the agent's word.** After every run the scheduler independently verifies the work landed on the remote (`git ls-remote`, `gh pr view`). "I pushed it" without a branch on origin is reported as a failure.
- **Fail loudly, in Linear.** A failed run posts a 🤖 comment with the error and the log tail, and moves the ticket back to Todo — you see failures where you already work.
- **One ticket at a time.** A PID lockfile serializes runs machine-wide. Predictable load, no token storms.
- **Crash-safe.** State is persisted before every irreversible step; a killed run (reboot, crash) is detected on the next tick and the ticket is recovered automatically.

## Requirements

- macOS (the background trigger uses `launchd`; the scheduler itself is plain Node and runs anywhere via `--loop`)
- Node.js ≥ 20
- [Claude Code CLI](https://claude.com/claude-code) installed and authenticated (`claude`)
- [GitHub CLI](https://cli.github.com) authenticated (`gh auth login`) — only needed for the `branch-pr` flow
- A [Linear](https://linear.app) personal API key

## Quick start

```bash
git clone https://github.com/kibadist/cron-claude-scheduler.git
cd cron-claude-scheduler
npm install && npm run build

# 1. Linear API key (Linear → Settings → Security & access → Personal API keys)
cp .env.example .env          # then edit: LINEAR_API_KEY=lin_api_...

# 2. Map your Linear projects to local git repositories
cp config.example.json config.json   # then edit (reference below)

# 3. Create a small test ticket in Linear, move it to Todo, and run one tick:
npm run tick

# 4. Happy with the result? Install the background agent:
npm run install-agent
```

From then on: write a ticket, move it to **Todo**, review the PR that appears.

## Configuration

`config.json` (gitignored — your machine's mapping):

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
      "linearProject": "My Web App",
      "path": "/Users/you/Code/my-web-app",
      "gitFlow": "branch-pr",
      "baseBranch": "main"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `pollIntervalMinutes` | How often a tick fires (positive integer) |
| `claude.command` | The Claude Code binary (usually just `claude`) |
| `claude.timeoutMinutes` | A run exceeding this is killed and reported as a failure |
| `statuses.todo` / `inProgress` / `inReview` | Workflow state **names** in your Linear team (case-insensitive) |
| `statuses.done` | Target status after a successful verification run (optional, default `"Done"`) |
| `projects[].linearProject` | Linear project name (case-insensitive; must be unique in the list) |
| `projects[].path` | Absolute path to the local git workspace for that project |
| `projects[].gitFlow` | `branch-pr` \| `branch-push` \| `main-push` (see below) |
| `projects[].baseBranch` | Branch the work starts from / is pushed to |

Config is validated on startup with specific error messages (missing path, not a git repo, unknown gitFlow, duplicate project names, …).

### Git flows (per project)

| Flow | What the agent does | Verified by |
|---|---|---|
| `branch-pr` | branch `claude/<ticket>-<slug>` → push → `gh pr create` | branch on origin **and** PR exists |
| `branch-push` | same branch → push, no PR | branch on origin |
| `main-push` | commit directly to `baseBranch` → push | remote base branch advanced |

`branch-pr` is the recommended default: the PR is your review gate before anything reaches your main branch.

## The lifecycle of a ticket

1. **Select** — highest-priority (urgent → low, no-priority last), then oldest Todo ticket across your configured projects.
2. **Claim** — ticket moves to *In Progress*; the claim is persisted locally first, so a crash at any point is recoverable.
3. **Run** — `claude -p --dangerously-skip-permissions` is spawned in a **disposable git worktree** of the tip of `baseBranch` (your main checkout is never touched — no branch switches, no dirty-tree collisions), with a prompt built from the ticket's title, description, and comments, plus the git-flow instructions. Output streams to `logs/<TICKET>-<timestamp>.log`. The worktree is removed after the run; only what was pushed survives.
4. **Verify** — the scheduler checks the remote itself; the agent's claims are never trusted.
5. **Finalize** —
   - **Success:** ticket → *In Review*, 🤖 comment with the branch and PR link.
   - **Failure** (non-zero exit, timeout, or verification failed): 🤖 comment with the error and last 30 log lines, ticket → back to *Todo*, and it's **skipped** until you edit or comment on it — your touch means "try again". This prevents a broken ticket from burning tokens in a retry loop.

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run tick` | Run one tick: work the Todo queue, or verify an In Review ticket when Todo is empty |
| `npm run loop` | Run ticks continuously in a terminal (any OS; safe alongside launchd — the lockfile prevents overlap) |
| `npm run work` | One work-only tick (skip verification) |
| `npm run review` | One verification-only tick (see below) |
| `npm run review:loop` | Verification-only ticks, continuously |
| `npm run watch` | Live-tail the active ticket's run log, auto-switching between runs |
| `npm run install-agent` | Install + start the launchd agent (ticks every `pollIntervalMinutes`, survives reboots) |
| `npm run uninstall-agent` | Stop and remove the launchd agent |
| `npm test` | Run the test suite |

Logs: `logs/<TICKET>-<timestamp>.log` per work run, `logs/<TICKET>-verify-<timestamp>.log` per verification run, `logs/launchd.log` for the scheduler itself.

## Verification mode (`npm run review`)

The second half of the loop: instead of you reviewing every In Review ticket by hand, a verification agent checks the work **in the browser** and closes the ticket. The default tick does this automatically whenever the Todo queue is empty; `npm run review` forces a verification-only tick.

For each **In Review** ticket whose `claude/…` branch exists on origin (tickets a human moved to In Review are left alone), the scheduler:

1. Creates a **disposable git worktree** of the branch in a temp directory — your main checkout is never touched
2. Runs Claude there with the `/verify` skill: install deps, start the app locally, and verify each requirement of the ticket by exercising the real behavior in the browser
3. Requires a machine-readable `VERDICT: PASS` as the agent's final line — **fail-closed**: no marker, FAIL marker, timeout, or non-zero exit all count as failure
4. **PASS** → ticket moves to **Done** with a verification report comment; the PR stays open — merging remains your call
5. **FAIL** → 🤖 comment with the findings on the Linear ticket **and on the PR** (`gh pr comment`); the ticket stays In Review and is skipped until you touch it — or move it back to Todo to have the work agent fix the findings

Work ticks and verification ticks share the same lockfile, so they never run simultaneously. Run `npm run review` on demand, `npm run review:loop` in a terminal, or wire a second launchd agent if you want it fully automatic.

## Safety notes

- The agent runs with `--dangerously-skip-permissions` — that's what makes unattended operation possible. Only configure projects you trust the agent to work on, and prefer `branch-pr` so nothing lands on your base branch without your review.
- Every run (work and verification) happens in a **disposable git worktree**, never in your actual checkout — your open editor, uncommitted changes, and current branch are untouched.
- Secrets stay local: `.env` and `config.json` are gitignored.
- A laptop that sleeps mid-run is fine: launchd fires the missed tick on wake, the stale lock is detected, and the interrupted ticket is moved back to Todo with an explanatory comment.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Config error: …` on start | The message names the exact field — fix `config.json` |
| `claude could not be spawned` comment on a ticket | `claude` isn't on the PATH launchd sees — re-run `npm run install-agent` (it bakes the current locations of `node`/`claude`/`gh` into the agent) |
| `branch pushed but no PR was found` | `gh auth login`, or the repo's remote isn't on GitHub — switch that project to `branch-push` |
| Ticket stuck skipped | That's by design after a failure — edit or comment on the ticket to re-queue it |
| `Workflow state "…" not found` | Your Linear team uses different status names — set them in `statuses.*` |
| Nothing happens after install | `tail -f logs/launchd.log`; confirm the plist loaded with `launchctl list \| grep claude-scheduler` |

## Development

```bash
npm test            # 61 tests: unit + full-lifecycle integration
npx tsc --noEmit    # typecheck
```

The integration tests exercise the entire lifecycle against **real temporary git repositories** (a bare repo standing in for origin) with **stub `claude` executables** and an **in-memory Linear fake** — no API keys, no tokens, no network.

```
src/
  index.ts    entrypoint (one-shot tick, or --loop)
  tick.ts     orchestration: lock → recover → select → claim → run → verify → finalize
  config.ts   config.json loading + validation
  linear.ts   Linear API gateway (@linear/sdk)
  runner.ts   spawns claude, streams log, enforces timeout
  verify.ts   independent push/PR verification
  prompt.ts   ticket → agent prompt + branch naming
  state.ts    crash recovery + failed-ticket skip list
  lock.ts     PID lockfile (one run at a time)
```
