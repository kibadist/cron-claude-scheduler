import { dirname, join } from 'node:path';
import { prepareTicketAssets } from './assets.js';
import type { Config, ProjectConfig, TicketInfo } from './types.js';
import type { LinearGateway } from './linear.js';
import { acquireLock, releaseLock } from './lock.js';
import { isSkipped, loadState, saveState, type SchedulerState } from './state.js';
import { branchName, buildPrompt, buildVerifyPrompt } from './prompt.js';
import { logTail, runClaude, type RunResult } from './runner.js';
import { commentOnPr, mergePr, remoteBranchExists, verifyWork, type VerifyResult } from './verify.js';
import {
  addVerifyWorktree,
  addWorkWorktree,
  deleteLocalBranch,
  removeWorktree,
  worktreeHeadSha,
} from './worktree.js';

export type TickOutcome = 'locked' | 'idle' | 'success' | 'failure';

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

    const projectNames = config.projects.map((p) => p.linearProject);
    const issues = await linear.fetchTodoIssues(projectNames, config.statuses.todo);
    const eligible = issues.filter((t) => !isSkipped(state, t.id, t.updatedAt));
    if (eligible.length === 0) return 'idle';

    const ticket = eligible[0];
    const project = config.projects.find(
      (p) => p.linearProject.toLowerCase() === ticket.projectName.toLowerCase(),
    );
    if (!project) return 'idle'; // defensive: fetch is filtered to configured projects

    const branch = branchName(ticket.identifier, ticket.title);

    log(`working ${ticket.identifier} in ${project.path}`);
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
      // For main-push, the verification baseline is the exact commit the agent
      // builds on (the worktree's HEAD, just fetched) — capturing it any
      // earlier would let a third party's concurrent push masquerade as the
      // agent's work.
      const preRunSha = project.gitFlow === 'main-push' ? worktreeHeadSha(worktree) : '';
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
      // Remember the pushed branch so the review tick still finds it if the
      // ticket's title gets edited later.
      if (project.gitFlow !== 'main-push') state.branches[ticket.id] = branch;
      state.active = null;
      saveState(paths.state, state);
      log(`done ${ticket.identifier}: ${verdict.detail}`);
      return 'success';
    }

    await linear.addComment(ticket.id, failureComment(verdict.detail, logTail(logPath)));
    await linear.moveIssue(ticket.id, config.statuses.todo);
    // Re-fetch updatedAt AFTER our own writes so our comment/move don't count as "user touched it".
    state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
    state.active = null;
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

    const projectNames = config.projects.map((p) => p.linearProject);
    const issues = await linear.fetchTodoIssues(projectNames, config.statuses.inReview);
    const eligible = issues.filter((t) => !isSkipped(state, t.id, t.updatedAt));

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
      });
      detail = reviewVerdict(result, logPath, config.claude.timeoutMinutes);
    } catch (e) {
      detail = `could not prepare the verification workspace: ${(e as Error).message}`;
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
          const body = [
            `🤖 Scheduler: verification PASSED but auto-merge failed — ${merged.detail}.`,
            '',
            'The ticket stays In Review. Resolve the merge problem (conflict, branch',
            'protection, gh auth), then edit or comment on this ticket to retry.',
          ].join('\n');
          await linear.addComment(ticket.id, body);
          if (!commentOnPr(project.path, branch, body)) {
            log(`could not comment on the PR for ${branch} (no PR or gh unavailable)`);
          }
          state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
          state.active = null;
          saveState(paths.state, state);
          log(`verified ${ticket.identifier} but auto-merge failed: ${merged.detail}`);
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
        state.active = null;
        saveState(paths.state, state);
        log(`verified ${ticket.identifier} but could not move to ${config.statuses.done}`);
        return 'failure';
      }
      delete state.skips[ticket.id];
      delete state.branches[ticket.id]; // ticket is Done; no longer needed
      state.active = null;
      saveState(paths.state, state);
      log(`verified ${ticket.identifier}: PASS → ${config.statuses.done}`);
      return 'success';
    }

    const body = verifyFailureComment(detail, logTail(logPath));
    await linear.addComment(ticket.id, body);
    // Base-branch verifications have no PR to comment on.
    if (!onBase && !commentOnPr(project.path, branch, body)) {
      log(`could not comment on the PR for ${branch} (no PR or gh unavailable)`);
    }
    // Ticket stays In Review. Re-fetch updatedAt AFTER our writes so our own
    // comment doesn't count as "user touched it".
    state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
    state.active = null;
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
  if (outcome !== 'idle') return outcome;
  return runReviewTick(deps);
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
    'The ticket stays In Review. Edit or comment on it to re-queue verification,',
    'or move it back to Todo to have the work agent fix the findings.',
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
    'Edit or comment on this ticket to make it eligible for another attempt.',
  ].join('\n');
}
