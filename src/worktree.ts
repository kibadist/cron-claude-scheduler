import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function addWorktree(projectPath: string, ref: string, prefix: string): string {
  const worktreePath = join(mkdtempSync(join(tmpdir(), prefix)), 'wt');
  git(projectPath, ['worktree', 'add', '--detach', worktreePath, ref]);
  return worktreePath;
}

/**
 * Disposable, detached worktree of the tip of origin/<baseBranch> for a work
 * run, so the agent never touches the user's main checkout. Throws when the
 * fetch or worktree creation fails (e.g. network down).
 */
export function addWorkWorktree(projectPath: string, baseBranch: string): string {
  git(projectPath, ['fetch', 'origin', baseBranch]);
  return addWorktree(projectPath, `origin/${baseBranch}`, 'sched-work-');
}

/**
 * Disposable, detached worktree of origin/<branch> for a verification run.
 * Throws when the fetch or worktree creation fails.
 */
export function addVerifyWorktree(projectPath: string, branch: string): string {
  git(projectPath, ['fetch', 'origin', branch]);
  return addWorktree(projectPath, `origin/${branch}`, 'sched-verify-');
}

/** Best-effort cleanup; a leaked temp worktree must never fail the tick. */
export function removeWorktree(projectPath: string, worktreePath: string): void {
  try {
    git(projectPath, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    try {
      git(projectPath, ['worktree', 'prune']);
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort: drop the local branch ref the agent created inside a (now
 * removed) work worktree. The pushed remote branch is the one that matters. */
export function deleteLocalBranch(projectPath: string, branch: string): void {
  try {
    git(projectPath, ['branch', '-D', branch]);
  } catch {
    /* never created (e.g. main-push flow) or still checked out somewhere */
  }
}
