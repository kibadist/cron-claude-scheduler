import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

/**
 * Disposable worktree with the PR <branch> actually checked out (not detached)
 * plus origin/<baseBranch> fetched, so a conflict-resolution run can `git merge`
 * the base in, commit, and `git push` the branch. Throws when a fetch or the
 * worktree creation fails.
 */
export function addResolveWorktree(projectPath: string, branch: string, baseBranch: string): string {
  git(projectPath, ['fetch', 'origin', branch, baseBranch]);
  const worktreePath = join(mkdtempSync(join(tmpdir(), 'sched-resolve-')), 'wt');
  // -B resets/creates the local branch to origin/<branch> and checks it out.
  git(projectPath, ['worktree', 'add', '-B', branch, worktreePath, `origin/${branch}`]);
  return worktreePath;
}

/** The commit a worktree is checked out at — the exact base the agent builds on. */
export function worktreeHeadSha(worktreePath: string): string {
  return git(worktreePath, ['rev-parse', 'HEAD']).trim();
}

/** Best-effort cleanup; a leaked temp worktree must never fail the tick. Also
 * removes the mkdtemp parent dir the worktree lived in (addWorktree creates
 * `<tmpdir>/sched-xxx/wt`), so disposable worktree dirs don't pile up in tmp. */
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
  // `worktreePath` is `<tmpdir>/sched-xxx/wt`; drop the whole `sched-xxx` dir.
  try {
    rmSync(dirname(worktreePath), { recursive: true, force: true });
  } catch {
    /* ignore — cleanup is best-effort */
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
