import { execFileSync } from 'node:child_process';
import type { ProjectConfig } from './types.js';
import { addResolveWorktree, removeWorktree } from './worktree.js';

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

/** The PR's state for a head branch ("MERGED" | "OPEN" | "CLOSED"), or null
 * when there is no PR / gh is unavailable. */
function prState(cwd: string, branch: string): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Squash-merge the branch's PR. Never throws — a merge failure (conflict,
 * branch protection, gh auth) is reported as a result.
 *
 * Deliberately does NOT pass `--delete-branch`: that makes gh also delete the
 * LOCAL branch, which fails when a (possibly leaked) worktree still has it
 * checked out — and that post-merge error would mask an already-successful
 * remote merge, stranding a merged ticket In Review. The remote branch is
 * deleted best-effort and separately; the local branch/worktree are the
 * scheduler's own cleanup responsibility. Idempotent: an already-merged PR
 * (prior run, or this run merging before erroring) counts as success. */
export function mergePr(cwd: string, branch: string): MergeResult {
  try {
    execFileSync('gh', ['pr', 'merge', branch, '--squash'], { cwd, encoding: 'utf8' });
  } catch (e) {
    // The merge may have actually landed before gh errored on a later step.
    if (prState(cwd, branch) !== 'MERGED') return { ok: false, detail: (e as Error).message.trim() };
  }
  // Best-effort remote branch deletion — never affects merge success.
  try {
    execFileSync('git', ['push', 'origin', '--delete', branch], { cwd, encoding: 'utf8' });
  } catch {
    /* remote branch already gone (e.g. GitHub auto-delete) or protected */
  }
  return { ok: true, detail: `PR for \`${branch}\` squash-merged` };
}

/** Does the branch's PR fail to merge specifically because it CONFLICTS with
 * its base (as opposed to branch protection, required reviews, gh auth, …)?
 * Only a true conflict is worth spending a claude run to auto-resolve. Returns
 * false when gh is unavailable or the state can't be determined — conservative,
 * so we never launch a resolve run on a non-conflict failure. */
export function isMergeConflict(cwd: string, branch: string): boolean {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', branch, '--json', 'mergeable,mergeStateStatus', '--jq', '.mergeable + " " + .mergeStateStatus'],
      { cwd, encoding: 'utf8' },
    ).trim();
    return /\bCONFLICTING\b|\bDIRTY\b/.test(out);
  } catch {
    return false;
  }
}

/** Does the branch's PR fail to merge only because it is BEHIND its base — no
 * conflicts, just out of date (the "require branches to be up to date before
 * merging" branch-protection rule)? Unlike a real conflict this is fixable
 * deterministically (merge the base in, push) with no claude run needed. False
 * when conflicting, current, unknown, or gh unavailable — conservative, so a
 * non-BEHIND failure never triggers the cheap update path. */
export function isMergeBehind(cwd: string, branch: string): boolean {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', branch, '--json', 'mergeable,mergeStateStatus', '--jq', '.mergeable + " " + .mergeStateStatus'],
      { cwd, encoding: 'utf8' },
    ).trim();
    if (/\bCONFLICTING\b|\bDIRTY\b/.test(out)) return false; // a real conflict, not just stale
    return /\bBEHIND\b/.test(out);
  } catch {
    return false;
  }
}

/** Bring <branch> up to date with its base by merging origin/<baseBranch> in and
 * pushing — the deterministic fix for a BEHIND (out-of-date, conflict-free) PR.
 * No claude run: there is nothing to resolve. If the merge unexpectedly conflicts
 * (gh's BEHIND status was stale and the base actually clashes), it aborts cleanly
 * and reports failure so the caller can fall through to the conflict path. Never
 * throws. Fail-closed: only ok when the base is actually an ancestor of the
 * pushed branch afterwards. */
export function updateBranchToBase(projectPath: string, branch: string, baseBranch: string): MergeResult {
  let worktree: string | undefined;
  try {
    worktree = addResolveWorktree(projectPath, branch, baseBranch);
    try {
      git(worktree, ['merge', '--no-edit', `origin/${baseBranch}`]);
    } catch (e) {
      try {
        git(worktree, ['merge', '--abort']);
      } catch {
        /* nothing to abort */
      }
      return {
        ok: false,
        detail: `merging \`${baseBranch}\` in unexpectedly conflicted: ${(e as Error).message.trim()}`,
      };
    }
    git(worktree, ['push', 'origin', `HEAD:${branch}`]);
  } catch (e) {
    return { ok: false, detail: `could not update \`${branch}\` from \`${baseBranch}\`: ${(e as Error).message.trim()}` };
  } finally {
    if (worktree) removeWorktree(projectPath, worktree);
  }
  if (!branchContainsBase(projectPath, branch, baseBranch))
    return { ok: false, detail: `\`${branch}\` still does not contain \`${baseBranch}\` after the update` };
  return { ok: true, detail: `merged \`${baseBranch}\` into \`${branch}\` and pushed` };
}

/** Is origin/<base> fully contained in origin/<branch>? After a successful
 * conflict resolution the branch must have the base tip merged in and pushed.
 * This is a deterministic local check (no GitHub mergeability lag), so it's the
 * fail-closed gate that the resolve actually happened. */
export function branchContainsBase(cwd: string, branch: string, base: string): boolean {
  try {
    git(cwd, ['fetch', 'origin', branch, base]);
    git(cwd, ['merge-base', '--is-ancestor', `origin/${base}`, `origin/${branch}`]);
    return true; // exit 0 => base is an ancestor of branch
  } catch {
    return false; // non-zero (not an ancestor) or a fetch error
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
      const now = remoteHeadSha(project.path, branch);
      if (!now) return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      if (now === preRunSha)
        return {
          ok: false,
          detail: `branch \`${branch}\` was not updated — origin still has only a previous attempt's commits`,
        };
      return { ok: true, detail: `branch \`${branch}\` pushed to origin` };
    }
    case 'branch-pr': {
      const now = remoteHeadSha(project.path, branch);
      if (!now) return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      if (now === preRunSha)
        return {
          ok: false,
          detail: `branch \`${branch}\` was not updated — origin still has only a previous attempt's commits`,
        };
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
