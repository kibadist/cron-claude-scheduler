import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewTick, type TickPaths } from '../src/tick.js';
import { loadState } from '../src/state.js';
import { git, makeRepoPair, commitAndPush } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BRANCH = 'claude/kib-1-add-hello-endpoint';

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-resolve-test-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string, claudeCommand: string): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: claudeCommand, timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [
      { linearProject: 'Test Project', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main', mergeOnVerified: true },
    ],
    maxRetries: 0,
    maxMergeResolves: 1,
  };
}

/** Push a PR branch that changes README, then advance main with a CONFLICTING
 * change to the same file. Leaves the workspace on main (so the branch is free
 * to be checked out in the resolve worktree). */
function setupConflict(workspace: string): void {
  git(workspace, 'checkout', '-b', BRANCH);
  writeFileSync(join(workspace, 'README.md'), 'branch change\n');
  git(workspace, 'commit', '-am', 'branch change');
  git(workspace, 'push', '-u', 'origin', BRANCH);
  git(workspace, 'checkout', 'main');
  writeFileSync(join(workspace, 'README.md'), 'main change\n');
  git(workspace, 'commit', '-am', 'main change');
  git(workspace, 'push', 'origin', 'main');
}

/** Push a PR branch that changes one file, then advance main with a NON-conflicting
 * change to a different file — so the branch is BEHIND main but conflict-free.
 * Leaves the workspace on main (so the branch is free for the resolve worktree). */
function setupBehind(workspace: string): void {
  git(workspace, 'checkout', '-b', BRANCH);
  writeFileSync(join(workspace, 'feature.txt'), 'branch feature\n');
  git(workspace, 'add', 'feature.txt');
  git(workspace, 'commit', '-m', 'branch feature');
  git(workspace, 'push', '-u', 'origin', BRANCH);
  git(workspace, 'checkout', 'main');
  writeFileSync(join(workspace, 'other.txt'), 'main change\n');
  git(workspace, 'add', 'other.txt');
  git(workspace, 'commit', '-m', 'main change');
  git(workspace, 'push', 'origin', 'main');
}

// gh isn't available against the local bare origin, so inject the merge result
// (conflict) and the conflict check; the resolution itself runs against real git.
const mergeConflicts = () => ({ ok: false, detail: 'merge conflict' });
const isConflict = () => true;
const notConflict = () => false;

describe('runReviewTick conflict resolution', () => {
  it('auto-resolves a conflict, pushes the merged branch, requeues for re-verification', async () => {
    const { workspace } = makeRepoPair();
    setupConflict(workspace);
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-then-resolve.sh'));

    const outcome = await runReviewTick({
      config,
      linear,
      paths,
      merge: mergeConflicts,
      conflict: isConflict,
    });

    expect(outcome).toBe('resolved');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // not Done — re-verify the merged branch first
    expect(issue.comments.at(-1)).toContain('Auto-resolved');

    const state = loadState(paths.state);
    expect(state.resolves['issue-1']).toBe(1);
    expect(state.skips['issue-1']).toBeUndefined(); // NOT skipped — eligible next tick

    // origin/BRANCH actually contains origin/main now (the merge was pushed)
    git(workspace, 'fetch', 'origin');
    expect(() =>
      git(workspace, 'merge-base', '--is-ancestor', 'origin/main', `origin/${BRANCH}`),
    ).not.toThrow();
  });

  it('skips when the resolution budget is exhausted', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt'); // branch on origin; no resolution will run
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));
    config.maxMergeResolves = 0; // disable auto-resolution

    const outcome = await runReviewTick({
      config,
      linear,
      paths,
      merge: mergeConflicts,
      conflict: isConflict,
    });

    expect(outcome).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('auto-merge failed');
    expect(issue.comments.at(-1)).toContain('budget');
    expect(loadState(paths.state).skips['issue-1']).toBeDefined(); // skip-until-touched
  });

  it('auto-updates a BEHIND (conflict-free) branch deterministically and requeues', async () => {
    const { workspace } = makeRepoPair();
    setupBehind(workspace);
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    const outcome = await runReviewTick({
      config,
      linear,
      paths,
      merge: () => ({ ok: false, detail: 'not up to date with base' }),
      conflict: notConflict,
      behind: () => true,
      // no `update` injected — the real git-based updateBranchToBase runs
    });

    expect(outcome).toBe('resolved');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // re-verify before merge
    expect(issue.comments.at(-1)).toContain('out of date');

    const state = loadState(paths.state);
    expect(state.resolves['issue-1']).toBe(1);
    expect(state.skips['issue-1']).toBeUndefined();

    // origin/BRANCH now contains origin/main (the merge was pushed) — no claude run
    git(workspace, 'fetch', 'origin');
    expect(() =>
      git(workspace, 'merge-base', '--is-ancestor', 'origin/main', `origin/${BRANCH}`),
    ).not.toThrow();
  });

  it('skips when a BEHIND branch update itself fails', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    const outcome = await runReviewTick({
      config,
      linear,
      paths,
      merge: () => ({ ok: false, detail: 'not up to date with base' }),
      conflict: notConflict,
      behind: () => true,
      update: () => ({ ok: false, detail: 'push rejected' }),
    });

    expect(outcome).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('automatic branch update also failed');
    expect(loadState(paths.state).skips['issue-1']).toBeDefined();
  });

  it('falls back to skip when the resolution run itself fails', async () => {
    const { workspace } = makeRepoPair();
    setupConflict(workspace);
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-resolve-fail.sh'));

    const outcome = await runReviewTick({
      config,
      linear,
      paths,
      merge: mergeConflicts,
      conflict: isConflict,
    });

    expect(outcome).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('automatic conflict resolution also failed');
    expect(loadState(paths.state).skips['issue-1']).toBeDefined();
    // the branch was NOT advanced (nothing pushed)
    git(workspace, 'fetch', 'origin');
    expect(() =>
      git(workspace, 'merge-base', '--is-ancestor', 'origin/main', `origin/${BRANCH}`),
    ).toThrow();
  });
});
