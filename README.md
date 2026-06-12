# cron-claude-scheduler

**Turn your Linear board into a work queue for autonomous Claude Code agents.**

Point it at a Linear project → within minutes, a [Claude Code](https://claude.com/claude-code) agent picks up any ticket that still needs doing — **any non-terminal status** (Backlog, Todo, Triage, …), not just one column — implements it in a disposable worktree of the right local git repository, runs the tests, pushes a branch, opens a pull request, and moves the ticket to **In Review**. When there's nothing left to implement, the same scheduler spends its ticks on the other half: a verification agent checks each In Review ticket **in the browser** against a running local build and moves it to **Done**. It drains the whole project to Done on its own; you just merge PRs (or let it auto-merge). Tickets a human is mid-flight on (**In Progress**) are left alone.

```
            ┌──────────────────────── scheduler (launchd tick every N min) ───┐
            │                                                                 │
 Linear     │   work tick                          claude -p in a disposable  │
 ┌────────┐ │   ┌──────────────────────────────►   worktree of origin/main    │
 │  Todo  │─┘   │  implement → test → push → PR    (your checkout untouched)  │
 └────────┘     │                                                             │
 ┌──────────┐   ◄── verified: branch on origin? PR exists? (git ls-remote/gh) │
 │In Review │─┐                                                               │
 └──────────┘ │ verification tick (when Todo is empty)                        │
 ┌────────┐   └──────────────────────────────►   /verify in a worktree of the │
 │  Done  │  ◄── final `VERDICT: PASS` required   PR branch: run the app,     │
 └────────┘      (fail-closed)                    check it in the browser     │
```

## Why

If you already write well-scoped tickets, the remaining work of *starting* an agent — opening a terminal, cd-ing to the right repo, pasting the ticket, babysitting the run, updating the ticket — is pure overhead. This scheduler removes it. Linear becomes the only interface: tickets in, pull requests out.

Design principles:

- **Never trust the agent's word.** After every run the scheduler independently verifies the work landed on the remote (`git ls-remote`, `gh pr view`). "I pushed it" without a branch on origin is reported as a failure. Browser verification is fail-closed: only an explicit final `VERDICT: PASS` closes a ticket.
- **Never touch the user's checkout.** Every run — work and verification — happens in a disposable git worktree in a temp directory. Your open editor, current branch, and uncommitted changes are physically out of reach.
- **Fail loudly, in Linear.** A failed run posts a 🤖 comment with the error and the log tail — you see failures where you already work.
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

From then on: write a ticket, move it to **Todo**, and merge the PR once the ticket reaches **Done** — implementation, push, PR, and browser verification all happen on their own.

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
    "inReview": "In Review",
    "done": "Done"
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
| `claude.limitCooldownMinutes` | Pause all ticks this long after claude hits a usage/rate limit (optional, default `30`) |
| `claude.model` | Model passed to every run as `--model` (e.g. `"opus"`, `"sonnet"`). Optional; omit to use the `claude` CLI's own default. Overridden per project by `projects[].model` |
| `claude.args` | Extra CLI flags appended to every `claude` invocation, e.g. `["--verbose"]` (optional, escape hatch) |
| `maxRetries` | How many times a failed verification automatically moves the ticket back to Todo for re-implementation before requiring your touch (optional, default `1`; `0` disables) |
| `maxMergeResolves` | How many times the scheduler auto-resolves a merge conflict (merge base in, fix conflicts, re-verify) on a verified-but-unmergeable PR before requiring your touch (optional, default `1`; `0` disables) |
| `statuses.todo` / `inProgress` / `inReview` | Workflow state **names** in your Linear team (case-insensitive) |
| `statuses.done` | Target status after a successful verification run (optional, default `"Done"`) |
| `projects[].linearProject` | Linear project name (case-insensitive; must be unique in the list) |
| `projects[].path` | Absolute path to the local git workspace for that project |
| `projects[].gitFlow` | `branch-pr` \| `branch-push` \| `main-push` (see below) |
| `projects[].baseBranch` | Branch the work starts from / is pushed to |
| `projects[].mergeOnVerified` | `branch-pr` only: squash-merge the PR automatically after browser verification passes (optional, default `false`) |
| `projects[].model` | Overrides `claude.model` for this project's work and review runs — e.g. `"opus"` for a hard repo, `"sonnet"` for QA (optional) |

Config is validated on startup with specific error messages (missing path, not a git repo, unknown gitFlow, duplicate project names, …).

### Git flows (per project)

| Flow | What the agent does | Verified by |
|---|---|---|
| `branch-pr` | branch `claude/<ticket>-<slug>` → push → `gh pr create` | branch on origin **and** PR exists |
| `branch-push` | same branch → push, no PR | branch on origin |
| `main-push` | commit directly to `baseBranch` → push | remote base branch advanced |

`branch-pr` is the recommended default: the PR is your review gate before anything reaches your main branch.

## The lifecycle of a ticket

1. **Select** — highest-priority (urgent → low, no-priority last), then oldest **workable** ticket across your configured projects. Workable = any non-terminal state (by Linear's state *type*: `triage`, `backlog`, `unstarted`) — so Backlog, Todo, and custom "ready" columns all qualify. **In Progress** (a human's, or an active run's), **In Review** (the verify tick owns it), **Done**, and **Canceled** are excluded.
2. **Claim** — ticket moves to *In Progress*; the claim is persisted locally first, so a crash at any point is recoverable.
3. **Run** — `claude -p --dangerously-skip-permissions` is spawned in a **disposable git worktree** of the tip of `baseBranch` (your main checkout is never touched — no branch switches, no dirty-tree collisions), with a prompt built from the ticket's title, description, and comments, the **Linear project's description as shared context** (write your product thesis once per project instead of repeating it in every ticket), plus the git-flow instructions. The repo's own `CLAUDE.md` applies too, as in any claude session. **Images pasted into the ticket** (screenshots, design mocks) are downloaded with your API key and handed to the agent as local files it actually looks at — both here and during verification. Output streams to `logs/<TICKET>-<timestamp>.log`. The worktree is removed after the run; only what was pushed survives.
4. **Verify** — the scheduler checks the remote itself; the agent's claims are never trusted.
5. **Finalize** —
   - **Success:** ticket → *In Review*, 🤖 comment with the branch and PR link.
   - **Failure** (non-zero exit, timeout, or verification failed): 🤖 comment with the error and last 30 log lines, ticket → back to *Todo*, and it's **skipped** until you edit or comment on it — your touch means "try again". This prevents a broken ticket from burning tokens in a retry loop.
6. **Hand-off** — the pushed branch is recorded against the ticket (so even renaming the ticket later can't lose it), and the ticket waits in *In Review* for a verification tick.

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run tick` | Run one tick: implement the next workable ticket, or verify an In Review ticket when there's nothing left to implement |
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

The second half of the loop: instead of you reviewing every In Review ticket by hand, a verification agent checks the work **in the browser** and closes the ticket. The default tick does this automatically whenever there's nothing left to implement; `npm run review` forces a verification-only tick.

For each **In Review** ticket, the scheduler:

1. Creates a **disposable git worktree** in a temp directory — of the ticket's `claude/…` branch when it exists on origin, otherwise of the **tip of `baseBranch`** (where the work should already live: `main-push` flow, or a PR merged manually). Your main checkout is never touched
2. Runs Claude there with the `/verify` skill: install deps, start the app locally, and verify each requirement of the ticket by exercising the real behavior in the browser
3. Requires a machine-readable `VERDICT: PASS` as the agent's final line — **fail-closed**: no marker, FAIL marker, timeout, or non-zero exit all count as failure
4. **PASS** → ticket moves to **Done** with a verification report comment. With `mergeOnVerified: true` the PR is **squash-merged automatically first**; otherwise the PR stays open and merging remains your call. **Merge conflicts self-heal:** if `main` advanced and the PR no longer merges cleanly, the scheduler spawns an agent that merges `main` in, resolves the conflicts (preserving both sides), runs the build/tests, and pushes — then the ticket stays In Review and is **re-verified in the browser** before merging, so nothing reaches `main` without a fresh PASS. Bounded by `maxMergeResolves` (default 1); when exhausted, or for non-conflict failures (branch protection, gh auth), the ticket stays In Review with an actionable comment. Fail-closed: a resolution only counts if `main` is verifiably merged into the pushed branch
5. **FAIL** → 🤖 comment with the findings on the Linear ticket **and on the PR** (`gh pr comment`). With retry budget left (`maxRetries`, default 1), the ticket is **moved back to Todo automatically** — the work agent re-implements with the verifier's findings in its prompt and force-with-lease-updates the same branch/PR. Once the budget is exhausted, the ticket stays In Review skipped until you touch it. Environmental failures (workspace prep, usage limits) never consume retries.

With `mergeOnVerified` the loop is fully autonomous: code reaches `main` only after a passing browser verification, failures stay isolated on their branches, and your only job is writing tickets. Tickets without a PR branch (`main-push`, manually merged PRs) are verified against the base branch tip — the verifier is told the work should already be merged there, and its absence is a FAIL.

Work ticks and verification ticks share the same lockfile, so they never run simultaneously — and the default tick already alternates between them, so the single launchd agent drives the entire Todo → In Review → Done loop with no extra setup.

## Safety notes

- The agent runs with `--dangerously-skip-permissions` — that's what makes unattended operation possible. Only configure projects you trust the agent to work on, and prefer `branch-pr` so nothing lands on your base branch without your review.
- Every run (work and verification) happens in a **disposable git worktree**, never in your actual checkout — your open editor, uncommitted changes, and current branch are untouched.
- Secrets stay local: `.env` and `config.json` are gitignored.
- A laptop that sleeps mid-run is fine: launchd fires the missed tick on wake, the stale lock is detected, and the interrupted ticket is moved back to Todo with an explanatory comment.

## How is this different from Claude Code's scheduled (cloud) agents?

Claude Code's `/schedule` routines run **in Anthropic's cloud** on a cron — great for machine-independent chores (summarize issues, babysit PRs). This scheduler is a **local pipeline** where the orchestration is deterministic code and Claude is only the worker inside it:

- It runs in **your repos with your toolchain** — local env files, databases, package caches, `gh`/`claude` auth.
- It can **verify work in the browser** against an app running locally — impossible from a cloud sandbox.
- Verification is **code, not trust**: pushes are proven via `git ls-remote`/`gh pr view`, verdicts are fail-closed, and the ticket lifecycle (locking, crash recovery, skip lists) is enforced by the scheduler, not by prompt obedience.

The two compose fine: use this for the local factory floor, and `/schedule` for cloud-side chores around it.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Config error: …` on start | The message names the exact field — fix `config.json` |
| `claude could not be spawned` comment on a ticket | `claude` isn't on the PATH launchd sees — re-run `npm run install-agent` (it bakes the current locations of `node`/`claude`/`gh` into the agent) |
| `branch pushed but no PR was found` | `gh auth login`, or the repo's remote isn't on GitHub — switch that project to `branch-push` |
| Ticket stuck skipped | That's by design after a failure — **add** a comment or edit the ticket to re-queue it. Deleting the 🤖 failure comment does NOT count: Linear doesn't register deletions as updates |
| `paused until …` in the log | claude hit its usage/rate limit — the affected ticket went back to its queue untouched and ticks resume automatically after `limitCooldownMinutes` |
| `Workflow state "…" not found` | Your Linear team uses different status names — set them in `statuses.*` |
| Nothing happens after install | `tail -f logs/launchd.log`; confirm the plist loaded with `launchctl list \| grep claude-scheduler` |

## Development

```bash
npm test            # 76 tests: unit + full-lifecycle integration
npx tsc --noEmit    # typecheck
```

The integration tests exercise both lifecycles (work and verification) against **real temporary git repositories** (a bare repo standing in for origin) with **stub `claude` executables** and an **in-memory Linear fake** — no API keys, no tokens, no network.

```
src/
  index.ts     entrypoint: unified tick by default; --work / --review / --loop
  tick.ts      orchestration: lock → recover → select → claim → run → verify → finalize
  config.ts    config.json loading + validation
  linear.ts    Linear API gateway (@linear/sdk)
  runner.ts    spawns claude, streams log, enforces timeout
  verify.ts    independent push/PR verification + PR comments
  worktree.ts  disposable git worktrees (work + verification isolation)
  prompt.ts    ticket → agent prompts (work + verify) + branch naming
  state.ts     crash recovery, failed-ticket skip list, ticket → branch map
  lock.ts      PID lockfile (one run at a time)
```
