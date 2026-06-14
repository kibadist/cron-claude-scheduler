import { dirname, join } from 'node:path';
import { prepareTicketAssets } from './assets.js';
import type { Config, ProjectConfig, TicketInfo } from './types.js';
import type { LinearGateway } from './linear.js';
import { acquireLock, releaseLock } from './lock.js';
import {
  isCoolingDown,
  isPaused,
  isSkipped,
  loadState,
  saveState,
  type SchedulerState,
} from './state.js';
import { makeNotifier, type NotifyButton, type Notifier } from './notify.js';
import { branchName, buildPrompt, buildResolvePrompt, buildVerifyPrompt } from './prompt.js';
import { isLimitError, logTail, runClaude, type RunResult } from './runner.js';
import {
  branchContainsBase,
  classifyFailure,
  commentOnPr,
  isMergeBehind,
  isMergeConflict,
  mergePr,
  remoteBranchExists,
  remoteHeadSha,
  updateBranchToBase,
  verifyWork,
  type VerifyResult,
} from './verify.js';
import {
  addResolveWorktree,
  addVerifyWorktree,
  addWorkWorktree,
  deleteLocalBranch,
  removeWorktree,
  worktreeHeadSha,
} from './worktree.js';

export type TickOutcome = 'locked' | 'idle' | 'success' | 'failure' | 'paused' | 'resolved';

export interface TickPaths {
  lock: string;
  state: string;
  logsDir: string;
}

export interface TickDeps {
  config: Config;
  linear: LinearGateway;
  paths: TickPaths;
  /** injectable for tests; defaults to the real runner */
  run?: typeof runClaude;
  /** injectable for tests; defaults to the real gh-based PR merge */
  merge?: typeof mergePr;
  /** injectable for tests; defaults to the real gh-based conflict check */
  conflict?: typeof isMergeConflict;
  /** injectable for tests; defaults to the real gh-based "behind base" check */
  behind?: typeof isMergeBehind;
  /** injectable for tests; defaults to the real git-based branch update */
  update?: typeof updateBranchToBase;
  /** injectable for tests; defaults to a notifier built from config.notifications */
  notify?: Notifier;
  log?: (msg: string) => void;
}

export async function runTick(deps: TickDeps): Promise<TickOutcome> {
  const { config, linear, paths } = deps;
  const run = deps.run ?? runClaude;
  const log = deps.log ?? (() => {});

  if (!acquireLock(paths.lock)) return 'locked';
  try {
    const state = loadState(paths.state);
    await recoverInterrupted(state, deps);

    if (isPaused(state)) {
      log(`paused until ${state.pausedUntil} (claude usage limit)`);
      return 'paused';
    }

    const projectNames = config.projects.map((p) => p.linearProject);
    const issues = await linear.fetchWorkableIssues(projectNames);
    const eligible = issues.filter(
      (t) => !isSkipped(state, t.id, t.updatedAt) && !isCoolingDown(state, t.id),
    );
    if (eligible.length === 0) return 'idle';

    const ticket = eligible[0];
    const project = config.projects.find(
      (p) => p.linearProject.toLowerCase() === ticket.projectName.toLowerCase(),
    );
    if (!project) return 'idle'; // defensive: fetch is filtered to configured projects

    const branch = branchName(ticket.identifier, ticket.title);

    log(`working ${ticket.identifier} in ${project.path}`);
    state.labels[ticket.id] = ticket.identifier; // so the bot can name/resolve it
    // Persist the claim BEFORE moving the ticket in Linear. A crash in this
    // window leaves `active` set with the ticket still in Todo, so the next
    // tick's recovery fires harmlessly (Todo→Todo) and the ticket stays
    // eligible. The reverse order would orphan the ticket In Progress with no
    // persisted `active`, so recovery would never fire.
    state.active = {
      issueId: ticket.id,
      identifier: ticket.identifier,
      startedAt: new Date().toISOString(),
      mode: 'work',
    };
    saveState(paths.state, state);
    await linear.moveIssue(ticket.id, config.statuses.inProgress);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(paths.logsDir, `${ticket.identifier}-${stamp}.log`);

    // The agent works in a disposable worktree of origin/<baseBranch> so the
    // user's main checkout is never touched (branch switches, dirty trees, …).
    let verdict: VerifyResult;
    let worktree: string | undefined;
    try {
      worktree = addWorkWorktree(project.path, project.baseBranch);
      // Verification baseline. main-push: the exact commit the agent builds on
      // (the worktree's HEAD, just fetched) — capturing it any earlier would
      // let a third party's concurrent push masquerade as the agent's work.
      // Branch flows: the branch's current remote SHA ('' when new), so a
      // leftover branch from a previous attempt can't pass verification
      // without being updated.
      const preRunSha =
        project.gitFlow === 'main-push'
          ? worktreeHeadSha(worktree)
          : remoteHeadSha(project.path, branch);
      // Ticket images live OUTSIDE the worktree so the agent can't accidentally
      // commit them; claude reads them via absolute paths.
      const assets = await prepareTicketAssets(ticket, join(dirname(worktree), 'assets'), (url) =>
        linear.downloadImage(url),
      );
      const result = await run({
        command: config.claude.command,
        prompt: buildPrompt(assets.ticket, project, branch, assets.imagePaths),
        cwd: worktree,
        timeoutMs: config.claude.timeoutMinutes * 60_000,
        logPath,
        model: project.model ?? config.claude.model,
        extraArgs: config.claude.args,
      });
      verdict = verdictFor(result, project, branch, preRunSha, config.claude.timeoutMinutes);
    } catch (e) {
      verdict = { ok: false, detail: `could not prepare the work workspace: ${(e as Error).message}` };
    } finally {
      if (worktree) {
        removeWorktree(project.path, worktree);
        // The branch ref created inside the worktree is local clutter; the
        // pushed remote branch is what verification and review use.
        if (project.gitFlow !== 'main-push') deleteLocalBranch(project.path, branch);
      }
    }

    if (verdict.ok) {
      await linear.addComment(ticket.id, successComment(verdict, branch, project));
      await linear.moveIssue(ticket.id, config.statuses.inReview);
      delete state.skips[ticket.id];
      clearBreaker(state, ticket.id); // a success ends any failure streak
      // Remember the pushed branch so the review tick still finds it if the
      // ticket's title gets edited later.
      if (project.gitFlow !== 'main-push') state.branches[ticket.id] = branch;
      state.active = null;
      saveState(paths.state, state);
      log(`done ${ticket.identifier}: ${verdict.detail}`);
      return 'success';
    }

    // A usage/rate limit is the account's problem, not the ticket's: put the
    // ticket back untouched (no comment, no skip) and pause all ticks so the
    // rest of the queue isn't burned through while the quota is drained.
    if (isLimitError(logTail(logPath, 50))) {
      await linear.moveIssue(ticket.id, config.statuses.todo);
      state.active = null;
      state.pausedUntil = pauseUntil(config);
      saveState(paths.state, state);
      log(`claude usage limit hit on ${ticket.identifier}; pausing until ${state.pausedUntil}`);
      return 'paused';
    }

    // A transient/environmental failure (workspace prep, network) is not the
    // ticket's fault: move it out of In Progress and back off with an
    // auto-lifting cooldown instead of parking it for a human.
    const kind = classifyFailure(verdict.detail, logTail(logPath, 50));
    if (kind === 'transient' && nextTransientStep(deps, state, ticket.id) === 'cooldown') {
      const cd = state.cooldowns[ticket.id];
      await linear.moveIssue(ticket.id, config.statuses.todo);
      await linear.addComment(
        ticket.id,
        transientComment(verdict.detail, cd.count, deps.config.autonomy?.maxTransientRetries ?? 4, cd.until),
      );
      state.active = null;
      await recordBreakerFailure(deps, state);
      saveState(paths.state, state);
      log(`transient failure on ${ticket.identifier}; cooling down until ${cd.until}`);
      return 'failure';
    }

    await linear.addComment(ticket.id, failureComment(verdict.detail, logTail(logPath)));
    await linear.moveIssue(ticket.id, config.statuses.todo);
    // Re-fetch updatedAt AFTER our own writes so our comment/move don't count as "user touched it".
    state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
    delete state.cooldowns[ticket.id];
    state.active = null;
    await recordBreakerFailure(deps, state);
    await escalate(
      deps,
      `🛑 ${ticket.identifier} parked — the work run could not produce a passing result: ${verdict.detail}. It stays skipped until you edit or comment on it in Linear.`,
      parkButtons(ticket.id),
    );
    saveState(paths.state, state);
    log(`failed ${ticket.identifier}: ${verdict.detail}`);
    return 'failure';
  } finally {
    releaseLock(paths.lock);
  }
}

/**
 * Handle an `active` record left behind by a run that died while holding the
 * lock. Work runs moved the ticket to In Progress, so they must be moved back
 * to Todo with an explanatory comment. Review runs never changed the ticket's
 * status — clearing the record is enough; the ticket is simply retried.
 */
async function recoverInterrupted(state: SchedulerState, deps: TickDeps): Promise<void> {
  if (!state.active) return;
  const { config, linear, paths } = deps;
  const log = deps.log ?? (() => {});

  if ((state.active.mode ?? 'work') === 'review') {
    log(`previous verification of ${state.active.identifier} was interrupted; it will be retried`);
  } else {
    log(`recovering interrupted ticket ${state.active.identifier}`);
    await linear.addComment(
      state.active.issueId,
      `🤖 Scheduler: the previous run on this ticket was interrupted (crash or restart). Moving it back to ${config.statuses.todo}.`,
    );
    await linear.moveIssue(state.active.issueId, config.statuses.todo);
  }
  state.active = null;
  saveState(paths.state, state);
}

/**
 * One verification tick: pick an In Review ticket the scheduler worked
 * (its claude/ branch exists on origin), run claude's /verify flow in a
 * disposable worktree of that branch, and on an observed PASS move the
 * ticket to Done. Failures comment on the ticket AND its PR, leave the
 * ticket In Review, and skip it until a human touches it.
 */
export async function runReviewTick(deps: TickDeps): Promise<TickOutcome> {
  const { config, linear, paths } = deps;
  const run = deps.run ?? runClaude;
  const log = deps.log ?? (() => {});

  if (!acquireLock(paths.lock)) return 'locked';
  try {
    const state = loadState(paths.state);
    await recoverInterrupted(state, deps);

    if (isPaused(state)) {
      log(`paused until ${state.pausedUntil} (claude usage limit)`);
      return 'paused';
    }

    const projectNames = config.projects.map((p) => p.linearProject);
    const issues = await linear.fetchIssuesByStatus(projectNames, config.statuses.inReview);
    const eligible = issues.filter(
      (t) => !isSkipped(state, t.id, t.updatedAt) && !isCoolingDown(state, t.id),
    );

    // Evict branch records for tickets that left In Review by any path other
    // than our own PASS (merged/cancelled/moved manually) so the map stays
    // bounded by the live In Review set.
    const inReviewIds = new Set(issues.map((t) => t.id));
    let pruned = false;
    for (const id of Object.keys(state.branches)) {
      if (!inReviewIds.has(id)) {
        delete state.branches[id];
        pruned = true;
      }
    }
    if (pruned) saveState(paths.state, state);

    // Verify against the ticket's PR branch when it exists on origin;
    // otherwise fall back to the tip of the base branch — the work is
    // expected to already live there (main-push flow, or a PR that was
    // merged and its branch deleted manually).
    let picked:
      | { ticket: TicketInfo; project: ProjectConfig; branch: string; onBase: boolean }
      | undefined;
    for (const ticket of eligible) {
      const project = config.projects.find(
        (p) => p.linearProject.toLowerCase() === ticket.projectName.toLowerCase(),
      );
      if (!project) continue;
      // Prefer the branch recorded by the work run — it survives title edits.
      const branch = state.branches[ticket.id] ?? branchName(ticket.identifier, ticket.title);
      try {
        picked = remoteBranchExists(project.path, branch)
          ? { ticket, project, branch, onBase: false }
          : { ticket, project, branch: project.baseBranch, onBase: true };
        break;
      } catch (e) {
        log(`could not check origin for ${ticket.identifier}: ${(e as Error).message}`);
      }
    }
    if (!picked) return 'idle';
    const { ticket, project, branch, onBase } = picked;

    log(`verifying ${ticket.identifier} (${onBase ? `tip of ${branch}` : branch})`);
    state.labels[ticket.id] = ticket.identifier; // so the bot can name/resolve it
    state.active = {
      issueId: ticket.id,
      identifier: ticket.identifier,
      startedAt: new Date().toISOString(),
      mode: 'review',
    };
    saveState(paths.state, state);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(paths.logsDir, `${ticket.identifier}-verify-${stamp}.log`);

    let detail: string | null = null;
    let prepFailed = false;
    let worktree: string | undefined;
    try {
      worktree = addVerifyWorktree(project.path, branch);
      const assets = await prepareTicketAssets(ticket, join(dirname(worktree), 'assets'), (url) =>
        linear.downloadImage(url),
      );
      const result = await run({
        command: config.claude.command,
        prompt: buildVerifyPrompt(assets.ticket, branch, assets.imagePaths, onBase),
        cwd: worktree,
        timeoutMs: config.claude.timeoutMinutes * 60_000,
        logPath,
        model: project.model ?? config.claude.model,
        extraArgs: config.claude.args,
      });
      detail = reviewVerdict(result, logPath, config.claude.timeoutMinutes);
    } catch (e) {
      detail = `could not prepare the verification workspace: ${(e as Error).message}`;
      prepFailed = true; // environmental — re-implementing the ticket won't fix it
    } finally {
      if (worktree) removeWorktree(project.path, worktree);
    }

    if (detail === null) {
      // Auto-merge before touching the ticket: a failed merge must leave the
      // ticket In Review with an actionable comment, not half-finished.
      let mergeNote = '';
      if (onBase) {
        mergeNote = `verified on \`${branch}\` (no PR branch — the work is already on the base branch)`;
      } else if (project.mergeOnVerified) {
        const merged = (deps.merge ?? mergePr)(project.path, branch);
        if (!merged.ok) {
          let failDetail = merged.detail;
          // Two merge failures are auto-fixable without a human, both bounded by
          // maxMergeResolves and both followed by browser re-verification before
          // the actual merge:
          //   - CONFLICTING/DIRTY: the base advanced AND clashes — needs a claude
          //     run to merge the base in and resolve.
          //   - BEHIND: out of date but conflict-free (the "require branches up to
          //     date" rule) — fixed deterministically by merging the base in, no
          //     claude run needed.
          // Anything else (branch protection, required reviews, gh auth) is not
          // auto-fixable and falls through to the skip-until-touched comment.
          const conflicting = (deps.conflict ?? isMergeConflict)(project.path, branch);
          const behind = !conflicting && (deps.behind ?? isMergeBehind)(project.path, branch);
          const resolvesUsed = state.resolves[ticket.id] ?? 0;
          const maxResolves = config.maxMergeResolves ?? 1;

          if ((conflicting || behind) && resolvesUsed < maxResolves) {
            const resolution = behind
              ? (deps.update ?? updateBranchToBase)(project.path, branch, project.baseBranch)
              : await resolveMergeConflict(deps, { ticket, project, branch, logsDir: paths.logsDir });
            if (resolution === 'limit') {
              state.active = null;
              state.pausedUntil = pauseUntil(config);
              saveState(paths.state, state);
              log(`claude usage limit hit resolving ${ticket.identifier}; pausing until ${state.pausedUntil}`);
              return 'paused';
            }
            if (resolution.ok) {
              const attempt = resolvesUsed + 1;
              state.resolves[ticket.id] = attempt;
              const action = behind
                ? `Auto-updated it (attempt ${attempt} of ${maxResolves}): the PR was behind \`${project.baseBranch}\` (no conflicts), so merged \`${project.baseBranch}\` in and pushed.`
                : `Auto-resolved it (attempt ${attempt} of ${maxResolves}): merged \`${project.baseBranch}\` in, resolved the conflicts, ran the build/tests, and pushed.`;
              const body = [
                `🤖 Scheduler: verification PASSED but the PR could not merge — it ${behind ? 'was out of date' : `conflicted`} with \`${project.baseBranch}\`.`,
                action,
                '',
                'Re-verifying the updated branch in the browser before merging — the ticket stays In Review.',
              ].join('\n');
              await linear.addComment(ticket.id, body);
              commentOnPr(project.path, branch, body); // best-effort
              // Leave In Review and DO NOT skip: the next review tick re-verifies
              // the now-mergeable branch and merges it on a fresh PASS.
              clearBreaker(state, ticket.id); // a successful heal ends the streak
              state.active = null;
              saveState(paths.state, state);
              log(`auto-${behind ? 'updated' : 'resolved'} ${ticket.identifier} (attempt ${attempt}/${maxResolves}); requeued for re-verification`);
              return 'resolved';
            }
            failDetail = `${failDetail}; automatic ${behind ? 'branch update' : 'conflict resolution'} also failed — ${resolution.detail}`;
          } else if (conflicting || behind) {
            failDetail = `${failDetail} (automatic merge-heal budget of ${maxResolves} exhausted)`;
          }

          // A transient merge failure (gh auth, network) may clear on its own:
          // back off and retry the merge later instead of parking for a human.
          if (
            classifyFailure(failDetail) === 'transient' &&
            nextTransientStep(deps, state, ticket.id) === 'cooldown'
          ) {
            const cd = state.cooldowns[ticket.id];
            const body = transientComment(
              `auto-merge could not complete — ${failDetail}`,
              cd.count,
              deps.config.autonomy?.maxTransientRetries ?? 4,
              cd.until,
            );
            await linear.addComment(ticket.id, body);
            commentOnPr(project.path, branch, body);
            state.active = null;
            await recordBreakerFailure(deps, state);
            saveState(paths.state, state);
            log(`transient merge failure on ${ticket.identifier}; cooling down until ${cd.until}`);
            return 'failure';
          }

          const body = [
            `🤖 Scheduler: verification PASSED but auto-merge failed — ${failDetail}.`,
            '',
            'The ticket stays In Review. Resolve the merge problem (conflict, branch',
            'protection, gh auth), then edit or comment on this ticket to retry.',
          ].join('\n');
          await linear.addComment(ticket.id, body);
          if (!commentOnPr(project.path, branch, body)) {
            log(`could not comment on the PR for ${branch} (no PR or gh unavailable)`);
          }
          state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
          delete state.cooldowns[ticket.id];
          state.active = null;
          await recordBreakerFailure(deps, state);
          await escalate(
            deps,
            `🛑 ${ticket.identifier} parked — verification passed but the PR cannot be merged: ${failDetail}. Likely needs a human (branch protection, a required review, or gh auth). It stays In Review until you edit or comment on it in Linear.`,
            parkButtons(ticket.id),
          );
          saveState(paths.state, state);
          log(`verified ${ticket.identifier} but auto-merge failed: ${failDetail}`);
          return 'failure';
        }
        mergeNote = merged.detail;
      }
      await linear.addComment(ticket.id, verifySuccessComment(branch, logTail(logPath, 15), mergeNote));
      try {
        await linear.moveIssue(ticket.id, config.statuses.done);
      } catch (e) {
        // A misnamed Done state must not crash-loop full verification runs:
        // surface the config problem and skip the ticket until it's touched.
        await linear.addComment(
          ticket.id,
          `🤖 Scheduler: verification PASSED but the ticket could not be moved to "${config.statuses.done}": ${(e as Error).message}. Check statuses.done in config.json, then edit or comment on this ticket to retry.`,
        );
        state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
        delete state.cooldowns[ticket.id];
        state.active = null;
        await recordBreakerFailure(deps, state);
        await escalate(
          deps,
          `🛑 ${ticket.identifier} verified but could not be moved to "${config.statuses.done}": ${(e as Error).message}. This is a config problem (check statuses.done in config.json).`,
        );
        saveState(paths.state, state);
        log(`verified ${ticket.identifier} but could not move to ${config.statuses.done}`);
        return 'failure';
      }
      delete state.skips[ticket.id];
      delete state.branches[ticket.id]; // ticket is Done; no longer needed
      delete state.retries[ticket.id];
      delete state.resolves[ticket.id];
      delete state.labels[ticket.id];
      clearBreaker(state, ticket.id); // a Done ticket ends the failure streak
      state.active = null;
      saveState(paths.state, state);
      log(`verified ${ticket.identifier}: PASS → ${config.statuses.done}`);
      return 'success';
    }

    // Usage limit mid-verification: the ticket is fine (still In Review,
    // status never changed) — just pause and retry it after the cooldown.
    if (isLimitError(logTail(logPath, 50))) {
      state.active = null;
      state.pausedUntil = pauseUntil(config);
      saveState(paths.state, state);
      log(`claude usage limit hit verifying ${ticket.identifier}; pausing until ${state.pausedUntil}`);
      return 'paused';
    }

    // A transient/environmental failure (workspace prep, network, dev server)
    // is not the work being wrong: back off with an auto-lifting cooldown and
    // do NOT burn a re-implementation attempt.
    const kind = classifyFailure(detail, logTail(logPath, 50));
    if (kind === 'transient' && nextTransientStep(deps, state, ticket.id) === 'cooldown') {
      const cd = state.cooldowns[ticket.id];
      const body = transientComment(detail, cd.count, config.autonomy?.maxTransientRetries ?? 4, cd.until);
      await linear.addComment(ticket.id, body);
      if (!onBase) commentOnPr(project.path, branch, body);
      state.active = null;
      await recordBreakerFailure(deps, state);
      saveState(paths.state, state);
      log(`transient verification failure on ${ticket.identifier}; cooling down until ${cd.until}`);
      return 'failure';
    }

    // Auto-retry a GENUINE failure: hand the ticket back to the work agent by
    // moving it to Todo — the verifier's findings (the comment below) become
    // part of the next work prompt. (Exhausted-transient failures fall straight
    // through to the park below; re-implementing won't fix an env problem.)
    const retriesUsed = state.retries[ticket.id] ?? 0;
    const maxRetries = config.maxRetries ?? 1;
    if (kind === 'genuine' && !prepFailed && retriesUsed < maxRetries) {
      const attempt = retriesUsed + 1;
      const body = [
        `🤖 Scheduler: browser verification FAILED — ${detail}.`,
        '',
        'Last lines of the verification log:',
        '```',
        logTail(logPath),
        '```',
        '',
        `Moving the ticket back to ${config.statuses.todo} automatically for another implementation attempt (${attempt} of ${maxRetries}). These findings are part of the next work prompt.`,
      ].join('\n');
      await linear.addComment(ticket.id, body);
      if (!onBase && !commentOnPr(project.path, branch, body)) {
        log(`could not comment on the PR for ${branch} (no PR or gh unavailable)`);
      }
      await linear.moveIssue(ticket.id, config.statuses.todo);
      state.retries[ticket.id] = attempt;
      // Deliberately NO skip entry: the ticket must be picked up by a work tick.
      state.active = null;
      await recordBreakerFailure(deps, state); // a failed verification counts toward the breaker
      saveState(paths.state, state);
      log(`verification failed ${ticket.identifier}; sent back to ${config.statuses.todo} (attempt ${attempt}/${maxRetries})`);
      return 'failure';
    }

    const exhausted =
      kind === 'genuine' && !prepFailed && maxRetries > 0
        ? `\n\nAutomatic re-implementation attempts exhausted (${maxRetries}).`
        : '';
    const body = verifyFailureComment(detail, logTail(logPath)) + exhausted;
    await linear.addComment(ticket.id, body);
    // Base-branch verifications have no PR to comment on.
    if (!onBase && !commentOnPr(project.path, branch, body)) {
      log(`could not comment on the PR for ${branch} (no PR or gh unavailable)`);
    }
    // Ticket stays In Review. Re-fetch updatedAt AFTER our writes so our own
    // comment doesn't count as "user touched it".
    state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
    delete state.cooldowns[ticket.id];
    state.active = null;
    await recordBreakerFailure(deps, state);
    await escalate(
      deps,
      `🛑 ${ticket.identifier} parked — browser verification keeps failing: ${detail}. ${
        kind === 'genuine' && maxRetries > 0 ? 'Re-implementation attempts are exhausted.' : ''
      } It stays In Review until you edit or comment on it in Linear.`.trim(),
      parkButtons(ticket.id),
    );
    saveState(paths.state, state);
    log(`verification failed ${ticket.identifier}: ${detail}`);
    return 'failure';
  } finally {
    releaseLock(paths.lock);
  }
}

/**
 * The default tick: work the Todo queue first; when there is no work to do,
 * spend the tick verifying an In Review ticket instead. One launchd agent
 * drives the whole Todo → In Review → Done loop.
 */
export async function runAutoTick(deps: TickDeps): Promise<TickOutcome> {
  const outcome = await runTick(deps);
  // 'paused' means the usage limit is drained — don't spend it further on review.
  if (outcome !== 'idle') return outcome;
  return runReviewTick(deps);
}

function pauseUntil(config: Config): string {
  const minutes = config.claude.limitCooldownMinutes ?? 30;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function haltUntil(config: Config): string {
  const minutes = config.autonomy?.haltCooldownMinutes ?? 60;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function cooldownUntil(config: Config): string {
  const minutes = config.autonomy?.transientCooldownMinutes ?? 15;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Best-effort escalation: log it and push it to the notifications channel,
 * optionally with tap-to-act buttons (Telegram). Never throws (the notifier
 * swallows delivery errors), so an escalation can't take a tick down. */
async function escalate(deps: TickDeps, text: string, buttons?: NotifyButton[]): Promise<void> {
  (deps.log ?? (() => {}))(`escalation: ${text}`);
  await (deps.notify ?? makeNotifier(deps.config, deps.log)).send(text, buttons);
}

/** Buttons offered on a per-ticket park escalation: retry just this ticket, or
 * pause the whole scheduler. The callback data is handled by the bot (bot.ts). */
function parkButtons(ticketId: string): NotifyButton[] {
  return [
    { label: '🔁 Retry this ticket', data: `retry:${ticketId}` },
    { label: '⏸ Pause scheduler', data: 'pause' },
  ];
}

/** Advance a ticket's transient-failure backoff. Returns 'cooldown' (set an
 * auto-lifting cooldown; budget remains) or 'exhausted' (the env problem isn't
 * clearing for this ticket — caller parks + escalates it as genuine). */
function nextTransientStep(deps: TickDeps, state: SchedulerState, ticketId: string): 'cooldown' | 'exhausted' {
  const prev = state.cooldowns[ticketId]?.count ?? 0;
  const max = deps.config.autonomy?.maxTransientRetries ?? 4;
  if (prev >= max) {
    delete state.cooldowns[ticketId];
    return 'exhausted';
  }
  state.cooldowns[ticketId] = { until: cooldownUntil(deps.config), count: prev + 1 };
  return 'cooldown';
}

/** Record one failure against the circuit breaker (mutates `state`; caller
 * saves). When consecutive failures reach the threshold the scheduler halts —
 * a long pause + reset + escalation — because a run of failures across tickets
 * means the environment is broken, not the tickets. Counts BOTH transient and
 * genuine failures; any success resets the streak via `clearBreaker`. */
async function recordBreakerFailure(deps: TickDeps, state: SchedulerState): Promise<void> {
  state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
  const threshold = deps.config.autonomy?.circuitBreakerThreshold ?? 3;
  if (threshold <= 0 || state.consecutiveFailures < threshold) return;
  const tripped = state.consecutiveFailures;
  state.pausedUntil = haltUntil(deps.config);
  state.consecutiveFailures = 0;
  await escalate(
    deps,
    `🚨 Scheduler circuit breaker tripped after ${tripped} consecutive failures. This usually means a systemic problem — expired gh/claude auth, the dev server is down, or no network — not bad tickets. Pausing all ticks until ${state.pausedUntil}; it resumes automatically. Check the environment.`,
    [{ label: '▶️ Resume now', data: 'resume' }],
  );
}

/** A success/resolution clears the consecutive-failure streak and any cooldown
 * the ticket had accrued. */
function clearBreaker(state: SchedulerState, ticketId: string): void {
  state.consecutiveFailures = 0;
  delete state.cooldowns[ticketId];
}

function transientComment(reason: string, count: number, max: number, until: string): string {
  return [
    `🤖 Scheduler: hit a transient/environmental problem — ${reason}.`,
    '',
    `This is not the ticket's fault, so it does not count as a failed attempt. Backing off and retrying automatically after ${until} (transient retry ${count} of ${max}). No action needed unless it keeps recurring.`,
  ].join('\n');
}

/**
 * Run claude in a disposable worktree to merge the base branch into a verified
 * PR branch, resolve the conflicts, run the build/tests, and push. Returns
 * 'limit' when claude hit its usage limit (caller pauses); otherwise an ok/detail
 * result. Fail-closed: only ok when the run reported RESOLVED: OK AND the base
 * is now actually merged into the pushed branch.
 */
async function resolveMergeConflict(
  deps: TickDeps,
  args: { ticket: TicketInfo; project: ProjectConfig; branch: string; logsDir: string },
): Promise<'limit' | { ok: boolean; detail: string }> {
  const { config } = deps;
  const run = deps.run ?? runClaude;
  const { ticket, project, branch, logsDir } = args;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(logsDir, `${ticket.identifier}-resolve-${stamp}.log`);

  let worktree: string | undefined;
  try {
    worktree = addResolveWorktree(project.path, branch, project.baseBranch);
    const result = await run({
      command: config.claude.command,
      prompt: buildResolvePrompt(ticket, project, branch),
      cwd: worktree,
      timeoutMs: config.claude.timeoutMinutes * 60_000,
      logPath,
      model: project.model ?? config.claude.model,
      extraArgs: config.claude.args,
    });
    if (isLimitError(logTail(logPath, 50))) return 'limit';
    const verdict = resolveVerdict(result, logPath, config.claude.timeoutMinutes);
    if (verdict !== null) return { ok: false, detail: verdict };
    if (!branchContainsBase(project.path, branch, project.baseBranch))
      return {
        ok: false,
        detail: `\`${branch}\` still does not contain \`${project.baseBranch}\` after the resolution run`,
      };
    return { ok: true, detail: `merged \`${project.baseBranch}\` into \`${branch}\` and pushed` };
  } catch (e) {
    return {
      ok: false,
      detail: `could not prepare the conflict-resolution workspace: ${(e as Error).message}`,
    };
  } finally {
    if (worktree) removeWorktree(project.path, worktree);
  }
}

/** null = clean exit with a final RESOLVED: OK marker; otherwise a failure
 * detail. Fail-closed and last-marker-wins, mirroring reviewVerdict. */
function resolveVerdict(result: RunResult, logPath: string, timeoutMinutes: number): string | null {
  if (result.timedOut) return `resolution timed out after ${timeoutMinutes} minutes`;
  if (result.exitCode !== 0)
    return result.exitCode === null
      ? 'claude could not be spawned (is it installed and on PATH?)'
      : `claude exited with code ${result.exitCode}`;
  const verdicts = logTail(logPath, Number.MAX_SAFE_INTEGER)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^RESOLVED: (OK|FAIL)\b/.test(l));
  const last = verdicts.at(-1);
  if (last !== 'RESOLVED: OK')
    return last?.startsWith('RESOLVED: FAIL')
      ? last.replace(/^RESOLVED: FAIL\s*[—-]?\s*/, '').trim() || 'resolution reported FAIL'
      : 'resolution run ended without a RESOLVED: OK marker';
  return null;
}

/** null = verified PASS; otherwise a human-readable failure detail. Fail-closed:
 * anything short of a clean exit plus an explicit FINAL PASS marker is a failure.
 * Only the LAST verdict line in the whole log counts — an early line merely
 * quoting the "VERDICT: PASS" instruction must not override a final FAIL. */
function reviewVerdict(result: RunResult, logPath: string, timeoutMinutes: number): string | null {
  if (result.timedOut) return `verification timed out after ${timeoutMinutes} minutes`;
  if (result.exitCode !== 0)
    return result.exitCode === null
      ? 'claude could not be spawned (is it installed and on PATH?)'
      : `claude exited with code ${result.exitCode}`;
  const verdicts = logTail(logPath, Number.MAX_SAFE_INTEGER)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^VERDICT: (PASS|FAIL)\b/.test(l));
  if (verdicts.at(-1) !== 'VERDICT: PASS')
    return 'claude finished without a final `VERDICT: PASS` line (treated as a failed verification)';
  return null;
}

function verifySuccessComment(branch: string, reportTail: string, mergeNote = ''): string {
  return [
    '🤖 Scheduler: verified in the browser — moving to Done.',
    '',
    mergeNote ? `- ${mergeNote}` : `- branch: \`${branch}\` (PR left open for merge)`,
    '',
    'Verifier report (tail):',
    '```',
    reportTail,
    '```',
  ].join('\n');
}

function verifyFailureComment(detail: string, tail: string): string {
  return [
    `🤖 Scheduler: browser verification FAILED — ${detail}.`,
    '',
    'Last lines of the verification log:',
    '```',
    tail,
    '```',
    '',
    'The ticket stays In Review. To re-queue verification, ADD a comment or edit',
    'the ticket (deleting this comment does not count — Linear does not register',
    'deletions as updates), or move it back to Todo to have the work agent fix the findings.',
  ].join('\n');
}

function verdictFor(
  result: RunResult,
  project: ProjectConfig,
  branch: string,
  preRunSha: string,
  timeoutMinutes: number,
): VerifyResult {
  if (result.timedOut)
    return { ok: false, detail: `claude timed out after ${timeoutMinutes} minutes` };
  if (result.exitCode !== 0)
    return {
      ok: false,
      detail:
        result.exitCode === null
          ? 'claude could not be spawned (is it installed and on PATH?)'
          : `claude exited with code ${result.exitCode}`,
    };
  return verifyWork(project, branch, preRunSha);
}

function successComment(verdict: VerifyResult, branch: string, project: ProjectConfig): string {
  const lines = ['🤖 Scheduler: work completed and pushed.', '', `- ${verdict.detail}`];
  if (project.gitFlow !== 'main-push') lines.push(`- branch: \`${branch}\``);
  if (verdict.prUrl) lines.push(`- PR: ${verdict.prUrl}`);
  return lines.join('\n');
}

function failureComment(detail: string, tail: string): string {
  return [
    `🤖 Scheduler: run failed — ${detail}.`,
    '',
    'Last lines of the run log:',
    '```',
    tail,
    '```',
    '',
    'To make it eligible for another attempt, ADD a comment or edit the ticket',
    '(deleting this comment does not count — Linear does not register deletions as updates).',
  ].join('\n');
}
