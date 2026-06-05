import { execFileSync } from 'node:child_process';
import type { ProjectConfig } from './types.js';

export interface VerifyResult {
  ok: boolean;
  detail: string;
  prUrl?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function remoteBranchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['ls-remote', '--heads', 'origin', branch]).trim().length > 0;
}

export function remoteHeadSha(cwd: string, branch: string): string {
  const out = git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`]).trim();
  return out.split('\t')[0] ?? '';
}

export interface MergeResult {
  ok: boolean;
  detail: string;
}

/** Squash-merge the branch's PR and delete the branch. Never throws — a merge
 * failure (conflict, branch protection, gh auth) is reported as a result. */
export function mergePr(cwd: string, branch: string): MergeResult {
  try {
    execFileSync('gh', ['pr', 'merge', branch, '--squash', '--delete-branch'], {
      cwd,
      encoding: 'utf8',
    });
    return { ok: true, detail: `PR for \`${branch}\` squash-merged; branch deleted` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.trim() };
  }
}

/** Post a comment on the branch's PR. Best-effort: returns false when there is
 * no PR, gh is missing/unauthenticated, or the repo is not on GitHub. */
export function commentOnPr(cwd: string, branch: string, body: string): boolean {
  try {
    execFileSync('gh', ['pr', 'comment', branch, '--body', body], { cwd, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

export function prUrlForBranch(cwd: string, branch: string): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // no PR, gh not installed, or repo not on GitHub
  }
}

export function verifyWork(project: ProjectConfig, branch: string, preRunSha: string): VerifyResult {
  // A network hiccup or auth failure during ls-remote must surface as a soft
  // verification failure on the ticket, never crash the scheduler.
  try {
    return verifyWorkUnsafe(project, branch, preRunSha);
  } catch (e) {
    return { ok: false, detail: `could not verify push (git error): ${(e as Error).message}` };
  }
}

function verifyWorkUnsafe(project: ProjectConfig, branch: string, preRunSha: string): VerifyResult {
  switch (project.gitFlow) {
    case 'branch-push': {
      if (!remoteBranchExists(project.path, branch))
        return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      return { ok: true, detail: `branch \`${branch}\` pushed to origin` };
    }
    case 'branch-pr': {
      if (!remoteBranchExists(project.path, branch))
        return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      const prUrl = prUrlForBranch(project.path, branch);
      if (!prUrl) return { ok: false, detail: `branch \`${branch}\` was pushed but no PR was found` };
      return { ok: true, detail: `branch \`${branch}\` pushed, PR open`, prUrl };
    }
    case 'main-push': {
      const now = remoteHeadSha(project.path, project.baseBranch);
      if (!now || now === preRunSha)
        return { ok: false, detail: `remote \`${project.baseBranch}\` did not change — nothing was pushed` };
      return { ok: true, detail: `remote \`${project.baseBranch}\` advanced to ${now.slice(0, 8)}` };
    }
  }
}
