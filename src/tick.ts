import { join } from 'node:path';
import type { Config, ProjectConfig, TicketInfo } from './types.js';
import type { LinearGateway } from './linear.js';
import { acquireLock, releaseLock } from './lock.js';
import { isSkipped, loadState, saveState, type SchedulerState } from './state.js';
import { branchName, buildPrompt, buildVerifyPrompt } from './prompt.js';
import { logTail, runClaude, type RunResult } from './runner.js';
import { commentOnPr, remoteBranchExists, remoteHeadSha, verifyWork, type VerifyResult } from './verify.js';
import { addVerifyWorktree, removeVerifyWorktree } from './worktree.js';

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
    const preRunSha =
      project.gitFlow === 'main-push' ? remoteHeadSha(project.path, project.baseBranch) : '';

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
    const result = await run({
      command: config.claude.command,
      prompt: buildPrompt(ticket, project, branch),
      cwd: project.path,
      timeoutMs: config.claude.timeoutMinutes * 60_000,
      logPath,
    });

    const verdict = verdictFor(result, project, branch, preRunSha, config.claude.timeoutMinutes);

    if (verdict.ok) {
      await linear.addComment(ticket.id, successComment(verdict, branch, project));
      await linear.moveIssue(ticket.id, config.statuses.inReview);
      delete state.skips[ticket.id];
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

    // Only verify tickets the scheduler actually worked: their branch must be
    // on origin. Tickets a human moved to In Review are left alone.
    let picked: { ticket: TicketInfo; project: ProjectConfig; branch: string } | undefined;
    for (const ticket of eligible) {
      const project = config.projects.find(
        (p) => p.linearProject.toLowerCase() === ticket.projectName.toLowerCase(),
      );
      if (!project) continue;
      const branch = branchName(ticket.identifier, ticket.title);
      try {
        if (remoteBranchExists(project.path, branch)) {
          picked = { ticket, project, branch };
          break;
        }
      } catch (e) {
        log(`could not check origin for ${ticket.identifier}: ${(e as Error).message}`);
      }
    }
    if (!picked) return 'idle';
    const { ticket, project, branch } = picked;

    log(`verifying ${ticket.identifier} (${branch})`);
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
      const result = await run({
        command: config.claude.command,
        prompt: buildVerifyPrompt(ticket, branch),
        cwd: worktree,
        timeoutMs: config.claude.timeoutMinutes * 60_000,
        logPath,
      });
      detail = reviewVerdict(result, logPath, config.claude.timeoutMinutes);
    } catch (e) {
      detail = `could not prepare the verification workspace: ${(e as Error).message}`;
    } finally {
      if (worktree) removeVerifyWorktree(project.path, worktree);
    }

    if (detail === null) {
      await linear.addComment(ticket.id, verifySuccessComment(branch, logTail(logPath, 15)));
      await linear.moveIssue(ticket.id, config.statuses.done);
      delete state.skips[ticket.id];
      state.active = null;
      saveState(paths.state, state);
      log(`verified ${ticket.identifier}: PASS → ${config.statuses.done}`);
      return 'success';
    }

    const body = verifyFailureComment(detail, logTail(logPath));
    await linear.addComment(ticket.id, body);
    if (!commentOnPr(project.path, branch, body)) {
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

/** null = verified PASS; otherwise a human-readable failure detail. Fail-closed:
 * anything short of a clean exit plus an explicit PASS marker is a failure. */
function reviewVerdict(result: RunResult, logPath: string, timeoutMinutes: number): string | null {
  if (result.timedOut) return `verification timed out after ${timeoutMinutes} minutes`;
  if (result.exitCode !== 0)
    return result.exitCode === null
      ? 'claude could not be spawned (is it installed and on PATH?)'
      : `claude exited with code ${result.exitCode}`;
  if (!/^VERDICT: PASS\s*$/m.test(logTail(logPath, 50)))
    return 'claude finished without printing `VERDICT: PASS` (treated as a failed verification)';
  return null;
}

function verifySuccessComment(branch: string, reportTail: string): string {
  return [
    '🤖 Scheduler: verified in the browser — moving to Done.',
    '',
    `- branch: \`${branch}\` (PR left open for merge)`,
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
