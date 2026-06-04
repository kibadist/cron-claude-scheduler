import { join } from 'node:path';
import type { Config, ProjectConfig } from './types.js';
import type { LinearGateway } from './linear.js';
import { acquireLock, releaseLock } from './lock.js';
import { isSkipped, loadState, saveState } from './state.js';
import { branchName, buildPrompt } from './prompt.js';
import { logTail, runClaude, type RunResult } from './runner.js';
import { remoteHeadSha, verifyWork, type VerifyResult } from './verify.js';

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

    // A successful or failed run always clears `active`, so if it's set while we
    // hold the lock, the previous run died mid-ticket. Recover it.
    if (state.active) {
      log(`recovering interrupted ticket ${state.active.identifier}`);
      await linear.addComment(
        state.active.issueId,
        `🤖 Scheduler: the previous run on this ticket was interrupted (crash or restart). Moving it back to ${config.statuses.todo}.`,
      );
      await linear.moveIssue(state.active.issueId, config.statuses.todo);
      state.active = null;
      saveState(paths.state, state);
    }

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
    await linear.moveIssue(ticket.id, config.statuses.inProgress);
    state.active = {
      issueId: ticket.id,
      identifier: ticket.identifier,
      startedAt: new Date().toISOString(),
    };
    saveState(paths.state, state);

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
