import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Create a disposable, detached worktree of origin/<branch> in a temp
 * directory, so verification runs never touch the user's main checkout.
 * Throws when the fetch or worktree creation fails (e.g. network down).
 */
export function addVerifyWorktree(projectPath: string, branch: string): string {
  const worktreePath = join(mkdtempSync(join(tmpdir(), 'sched-verify-')), 'wt');
  git(projectPath, ['fetch', 'origin', branch]);
  git(projectPath, ['worktree', 'add', '--detach', worktreePath, `origin/${branch}`]);
  return worktreePath;
}

/** Best-effort cleanup; a leaked temp worktree must never fail the tick. */
export function removeVerifyWorktree(projectPath: string, worktreePath: string): void {
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
