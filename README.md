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
- **Fail loudly — and reach you.** A failed run posts a 🤖 comment with the error and the log tail where you already work, and genuinely-stuck tickets are pushed to your notifications channel (Slack / Discord / Telegram). From the **Telegram control bot** you can retry, pause, or resume right from your phone.
- **Self-heal what's mechanical; escalate what isn't.** Transient/environmental failures back off and retry themselves without burning attempts; merge conflicts and out-of-date branches are resolved automatically; a run of failures trips a **circuit breaker** that halts and escalates rather than thrashing. A human is pulled in only when one is genuinely needed.
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

This is the minimal shape. All other fields (`claude.model`, `maxRetries`, `maxMergeResolves`, `autonomy`, `notifications`, per-project `model`) are optional with sane defaults — see the table below, and [`config.example.json`](config.example.json) for a fully-populated example.

| Field | Meaning |
|---|---|
| `pollIntervalMinutes` | How often a tick fires (positive integer) |
| `claude.command` | The Claude Code binary (usually just `claude`) |
| `claude.timeoutMinutes` | A run exceeding this is killed and reported as a failure |
| `claude.limitCooldownMinutes` | Pause all ticks this long after claude hits a usage/rate limit (optional, default `30`) |
| `claude.model` | Model passed to every run as `--model` (e.g. `"opus"`, `"sonnet"`). Optional; omit to use the `claude` CLI's own default. Overridden per project by `projects[].model` |
| `claude.args` | Extra CLI flags appended to every `claude` invocation, e.g. `["--verbose"]` (optional, escape hatch) |
| `maxRetries` | How many times a failed verification automatically moves the ticket back to Todo for re-implementation before requiring your touch (optional, default `1`; `0` disables) |
| `maxMergeResolves` | How many times the scheduler auto-heals a verified-but-unmergeable PR — resolving a real conflict, or updating a branch that's merely behind base — before requiring your touch (optional, default `1`; `0` disables) |
| `autonomy.circuitBreakerThreshold` | Consecutive failures (across tickets, any kind) before the scheduler halts itself and escalates — a run of failures means the environment is broken, not the tickets (optional, default `3`; `0` disables) |
| `autonomy.haltCooldownMinutes` | How long the scheduler pauses after the breaker trips, before resuming automatically (optional, default `60`) |
| `autonomy.transientCooldownMinutes` | Backoff before retrying a ticket that hit a transient/environmental failure — auto-lifts, no human touch (optional, default `15`) |
| `autonomy.maxTransientRetries` | How many transient cooldown cycles a ticket gets before the failure is escalated as genuine (optional, default `4`) |
| `notifications` | Escalation channel for tickets that genuinely need a human. `{ "type": "slack"\|"discord"\|"webhook", "url": "…" }` or `{ "type": "telegram", "telegram": { "botToken": "…", "chatId": "…" } }`. Telegram also enables a two-way **control bot** (see below). Omit entirely to log escalations only |
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
   - **Transient failure** (workspace prep, network, dev server, gh auth): ticket → back to *Todo* with an **auto-lifting cooldown** — it retries itself without burning anything (see [Unattended operation](#unattended-operation-autonomy)).
   - **Genuine failure** (non-zero exit, timeout, the work didn't pass): 🤖 comment with the error and last 30 log lines, ticket → back to *Todo*, **skipped** until you edit or comment on it, and an **escalation** is pushed to your notifications channel. Your touch means "try again"; this prevents a broken ticket from burning tokens in a retry loop.
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
4. **PASS** → ticket moves to **Done** with a verification report comment. With `mergeOnVerified: true` the PR is **squash-merged automatically first**; otherwise the PR stays open and merging remains your call. **Unmergeable PRs self-heal:** if the PR can't merge because `main` advanced, the scheduler fixes it automatically — for a real **conflict** it spawns an agent that merges `main` in, resolves the conflicts (preserving both sides), runs the build/tests, and pushes; for a branch that's merely **behind base** (the "require branches up to date" rule — no conflicts) it just merges `main` in and pushes, deterministically, with no agent run. Either way the ticket stays In Review and is **re-verified in the browser** before merging, so nothing reaches `main` without a fresh PASS. Bounded by `maxMergeResolves` (default 1); when exhausted, or for non-auto-fixable failures (branch protection, required reviews, gh auth), the ticket stays In Review with an actionable comment. Fail-closed: a heal only counts if `main` is verifiably merged into the pushed branch
5. **FAIL** → 🤖 comment with the findings on the Linear ticket **and on the PR** (`gh pr comment`). With retry budget left (`maxRetries`, default 1), the ticket is **moved back to Todo automatically** — the work agent re-implements with the verifier's findings in its prompt and force-with-lease-updates the same branch/PR. Once the budget is exhausted, the ticket stays In Review skipped until you touch it. Environmental failures (workspace prep, usage limits) never consume retries.

With `mergeOnVerified` the loop is fully autonomous: code reaches `main` only after a passing browser verification, failures stay isolated on their branches, and your only job is writing tickets. Tickets without a PR branch (`main-push`, manually merged PRs) are verified against the base branch tip — the verifier is told the work should already be merged there, and its absence is a FAIL.

Work ticks and verification ticks share the same lockfile, so they never run simultaneously — and the default tick already alternates between them, so the single launchd agent drives the entire Todo → In Review → Done loop with no extra setup.

### Unattended operation (autonomy)

The scheduler is built to run for long stretches with no one watching, so it distinguishes *why* something failed and never gets silently stuck:

- **Transient vs. genuine failures.** An environmental hiccup (workspace prep, network, the dev server not starting, gh auth) is **not** the ticket's fault: the ticket gets an auto-lifting **cooldown** (`autonomy.transientCooldownMinutes`) and retries on its own — it does **not** consume a re-implementation attempt. Only a genuine "the work is wrong" verification failure burns `maxRetries`. A ticket that keeps hitting transient problems is escalated after `autonomy.maxTransientRetries` cycles.
- **Circuit breaker.** A run of `autonomy.circuitBreakerThreshold` consecutive failures (default 3, any kind, across tickets) almost always means something systemic — expired gh/claude auth, a dead dev server, no network — not three bad tickets. The scheduler then **halts itself** (pauses for `autonomy.haltCooldownMinutes`, default 60), escalates once, and resumes automatically. Any success resets the streak.
- **Escalation.** When a ticket is genuinely parked, or the breaker trips, the scheduler pushes a notification to your `notifications` channel (Slack / Discord / Telegram / generic webhook) so "skipped until you touch it" actually reaches you. With no channel configured, escalations are logged only. Delivery is best-effort and never blocks or crashes a tick.

### Telegram control bot

If your `notifications.type` is `telegram`, the same bot becomes **two-way** — you can drive the scheduler from your phone, and escalation alerts carry tap-to-act buttons.

**Setup:**
1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, copy the **bot token**.
2. Start a chat with your new bot (send it any message), then get your **chat id** (e.g. message [@userinfobot](https://t.me/userinfobot), or read it from `https://api.telegram.org/bot<token>/getUpdates`).
3. Put both in `config.json` and restart the loop:
   ```json
   "notifications": { "type": "telegram", "telegram": { "botToken": "…", "chatId": "…" } }
   ```

**Commands** (also available as buttons on alerts):

| Command | Does |
|---|---|
| `/status` | What's running, paused, parked, cooling, and the failure streak |
| `/parked` | List tickets parked (need a human) or cooling down (auto-retry) |
| `/retry <DET-123>` | Re-queue one parked ticket — the equivalent of editing it in Linear |
| `/retryall` | Re-queue **every** parked + cooling ticket (the bulk un-stick) |
| `/pause` | Stop all ticks |
| `/resume` | Resume ticks, and lift a circuit-breaker halt |

Park alerts show **🔁 Retry this ticket** / **⏸ Pause scheduler**; a breaker-halt alert shows **▶️ Resume now**.

A background poller (no extra process) drains commands **every ~8 seconds**, including *while a ticket is being worked* — the tick frees its lock during the Claude run, so `/status` and `/pause` stay responsive even mid-run. Only your configured `chatId` is honoured; messages from anyone else are ignored. Updates are processed exactly once via a persisted cursor, and `/pause`/`/resume` work even while the scheduler is paused.

`/pause` does **not** kill an in-flight Claude run — the current ticket finishes, then no new work starts. (The bot only runs in `--loop` mode; one-shot/launchd ticks hold their lock throughout and don't poll.)

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
| `circuit breaker tripped` escalation | A run of consecutive failures — usually systemic (expired `gh`/`claude` auth, dead dev server, no network). Fix the environment; it resumes after `autonomy.haltCooldownMinutes`, or `/resume` from the bot to lift it now |
| Telegram bot doesn't respond | The bot runs **only in `--loop` mode with a telegram channel** — confirm `npm run loop` is running and the log shows `Telegram control bot active`. After config changes, restart the loop. Only your configured `chatId` is honoured |
| `Workflow state "…" not found` | Your Linear team uses different status names — set them in `statuses.*` |
| Nothing happens after install | `tail -f logs/launchd.log`; confirm the plist loaded with `launchctl list \| grep claude-scheduler` |

## Development

```bash
npm test            # 150+ tests: unit + full-lifecycle integration
npm run build       # typecheck (tsc)
```

The integration tests exercise both lifecycles (work and verification) against **real temporary git repositories** (a bare repo standing in for origin) with **stub `claude` executables** and an **in-memory Linear fake** — no API keys, no tokens, no network.

```
src/
  index.ts     entrypoint: unified tick by default; --work / --review / --loop; starts the bot poller
  tick.ts      orchestration: lock → recover → select → claim → run → verify → finalize → escalate
  config.ts    config.json loading + validation
  linear.ts    Linear API gateway (@linear/sdk)
  runner.ts    spawns claude, streams log, enforces timeout
  verify.ts    independent push/PR verification, merge/conflict self-heal, failure classification
  worktree.ts  disposable git worktrees (work + verification isolation)
  prompt.ts    ticket → agent prompts (work + verify + conflict-resolve) + branch naming
  assets.ts    downloads ticket images (private Linear uploads) for the agent
  state.ts     crash recovery, skip list, cooldowns, retries, breaker streak, ticket → branch/label maps
  notify.ts    escalation notifier (Slack / Discord / Telegram / webhook)
  bot.ts       two-way Telegram control bot (commands + inline buttons)
  lock.ts      PID lockfile (one run at a time)
```
