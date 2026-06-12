import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoTick, runReviewTick, runTick, type TickPaths } from '../src/tick.js';
import { saveState, loadState } from '../src/state.js';
import { git, makeRepoPair, commitAndPush } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config, GitFlow } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BRANCH = 'claude/kib-1-add-hello-endpoint'; // branchName('KIB-1', 'Add hello endpoint')

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-review-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string, claudeCommand: string, gitFlow: GitFlow = 'branch-pr'): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: claudeCommand, timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [{ linearProject: 'Test Project', path: workspace, gitFlow, baseBranch: 'main' }],
    maxRetries: 0, // most tests exercise the no-auto-retry paths; retry tests override
  };
}

describe('runReviewTick', () => {
  it('verification passes: runs in a disposable worktree, posts report, moves to Done', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt'); // the work-run's branch is on origin
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    const outcome = await runReviewTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Done');
    expect(issue.comments.at(-1)).toContain('verified');

    // ran inside the temp worktree, not the user's checkout...
    const logFile = readdirSync(paths.logsDir).find((f) => f.includes('-verify-'))!;
    const logBody = readFileSync(join(paths.logsDir, logFile), 'utf8');
    expect(logBody).toContain('sched-verify-');
    expect(logBody).not.toContain(`verifying from: ${workspace}\n`);

    // ...and the worktree was cleaned up afterwards
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: workspace, encoding: 'utf8' });
    expect(worktrees.trim().split('\n')).toHaveLength(1); // only the main checkout
  });

  it('verification fails: comments, stays In Review, skipped until touched', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-fail.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // never moved
    expect(issue.comments.at(-1)).toContain('save button broken');

    // skipped on the next tick despite our own comment bumping updatedAt
    expect(await runReviewTick({ config, linear, paths })).toBe('idle');

    // user touches the ticket -> eligible again
    issue.ticket.updatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
  });

  it('fails closed when claude exits 0 without a VERDICT: PASS marker', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-ok.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('VERDICT');
  });

  it('is not fooled by an early quoted PASS marker before a final FAIL', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-quoted.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.status).toBe('In Review');
  });

  it('reports a timeout as a failed verification', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-slow.sh'));
    config.claude.timeoutMinutes = 0.01; // 600ms

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('timed out');
  });

  it('does not crash-loop when the Done state is misnamed', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    class NoDoneLinear extends FakeLinear {
      override async moveIssue(issueId: string, statusName: string): Promise<void> {
        if (statusName === 'Done') throw new Error('Workflow state "Done" not found');
        await super.moveIssue(issueId, statusName);
      }
    }
    const linear = new NoDoneLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('statuses.done');
    // skipped now — no repeated verification burn
    expect(await runReviewTick({ config, linear, paths })).toBe('idle');
  });

  it('auto-retry: failed verification moves the ticket back to Todo, work re-runs, budget exhausts', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    git(workspace, 'checkout', 'main'); // leave the workspace as production would:
    git(workspace, 'branch', '-D', BRANCH); // remote branch only, no local ref
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-fail.sh'), 'branch-push');
    config.maxRetries = 1;

    // 1st verification failure: handed straight back to the work agent
    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo'); // moved automatically — no human touch needed
    expect(issue.comments.at(-1)).toContain('another implementation attempt (1 of 1)');
    expect(loadState(paths.state).skips).toEqual({}); // NOT skip-listed: must stay eligible
    expect(loadState(paths.state).retries['issue-1']).toBe(1);

    // the work agent re-implements (force-with-lease updates the old branch)
    const workConfig = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'), 'branch-push');
    expect(await runTick({ config: workConfig, linear, paths })).toBe('success');
    expect(issue.status).toBe('In Review');

    // 2nd verification failure: budget exhausted -> stays In Review, skipped
    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('attempts exhausted');
    expect(await runReviewTick({ config, linear, paths })).toBe('idle'); // skip-until-touched now
  });

  it('mergeOnVerified: squash-merges the PR after PASS, then moves to Done', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));
    config.projects[0].mergeOnVerified = true;

    const mergedWith: string[] = [];
    const merge = (cwd: string, branch: string): { ok: boolean; detail: string } => {
      mergedWith.push(branch);
      return { ok: true, detail: `PR for \`${branch}\` squash-merged; branch deleted` };
    };

    expect(await runReviewTick({ config, linear, paths, merge })).toBe('success');
    expect(mergedWith).toEqual([BRANCH]);
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Done');
    expect(issue.comments.at(-1)).toContain('squash-merged');
  });

  it('mergeOnVerified: a failed merge keeps the ticket In Review and skips it', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));
    config.projects[0].mergeOnVerified = true;

    const merge = (): { ok: boolean; detail: string } => ({ ok: false, detail: 'merge conflict' });

    expect(await runReviewTick({ config, linear, paths, merge })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // never moved to Done
    expect(issue.comments.at(-1)).toContain('auto-merge failed');
    // skipped until touched — no merge-retry burn loop
    expect(await runReviewTick({ config, linear, paths, merge })).toBe('idle');
  });

  it('finds the branch via the recorded mapping when the title was edited after the work run', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt'); // branch from the ORIGINAL title
    const linear = new FakeLinear();
    linear.add(makeTicket({ title: 'Completely renamed by a human' }), 'In Review');
    const paths = makePaths();
    saveState(paths.state, {
      active: null,
      skips: {},
      branches: { 'issue-1': BRANCH }, // recorded by the work run
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('success');
    expect(linear.issues.get('issue-1')!.status).toBe('Done');
    expect(loadState(paths.state).branches['issue-1']).toBeUndefined(); // cleaned up
  });

  it('usage limit during verification: pauses without blaming the ticket', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-limit.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('paused');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // untouched
    expect(issue.comments).toHaveLength(0); // no failure comment
    const state = loadState(paths.state);
    expect(state.skips).toEqual({}); // will simply be retried after the cooldown
    expect(state.pausedUntil! > new Date().toISOString()).toBe(true);
  });

  it('evicts branch records for tickets that left In Review', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear(); // nothing In Review at all
    const paths = makePaths();
    saveState(paths.state, {
      active: null,
      skips: {},
      branches: { 'stale-ticket': 'claude/old-1-gone' },
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('idle');
    expect(loadState(paths.state).branches).toEqual({});
  });

  it('no branch on origin: verifies the tip of the base branch instead', async () => {
    const { workspace } = makeRepoPair(); // no claude/ branch pushed (e.g. main-push flow)
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));
    config.projects[0].mergeOnVerified = true; // must be ignored: nothing to merge

    let mergeCalled = false;
    const merge = (): { ok: boolean; detail: string } => {
      mergeCalled = true;
      return { ok: true, detail: 'should not happen' };
    };

    expect(await runReviewTick({ config, linear, paths, merge })).toBe('success');
    expect(mergeCalled).toBe(false);
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Done');
    expect(issue.comments.at(-1)).toContain('no PR branch');
  });

  it('no branch on origin: a failed base-branch verification stays In Review', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-fail.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('save button broken');
  });

  it('recovers silently from an interrupted review run and retries', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z', mode: 'review' },
      skips: {},
      branches: {},
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    const outcome = await runReviewTick({ config, linear, paths });

    expect(outcome).toBe('success'); // retried and passed
    const issue = linear.issues.get('issue-1')!;
    // no "interrupted" noise for review crashes — the ticket never left In Review
    expect(issue.comments.some((c) => c.includes('interrupted'))).toBe(false);
    expect(issue.status).toBe('Done');
  });

  it('recovers an interrupted WORK run before reviewing (back to Todo)', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Progress'); // stuck work run
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z', mode: 'work' },
      skips: {},
      branches: {},
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('idle'); // nothing In Review
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments[0]).toContain('interrupted');
  });
});

describe('runAutoTick', () => {
  it('works the Todo queue when there is work', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket()); // Todo
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'), 'branch-push');

    expect(await runAutoTick({ config, linear, paths })).toBe('success');
    expect(linear.issues.get('issue-1')!.status).toBe('In Review');
  });

  it('falls through to verification when Todo is empty', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review'); // nothing in Todo
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runAutoTick({ config, linear, paths })).toBe('success');
    expect(linear.issues.get('issue-1')!.status).toBe('Done');
  });
});

describe('runTick with a review-mode active record', () => {
  it('clears it silently without moving the ticket to Todo', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review'); // mid-verification when the crash happened
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z', mode: 'review' },
      skips: {},
      branches: {},
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'), 'branch-push');

    expect(await runTick({ config, linear, paths })).toBe('idle'); // nothing in Todo
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // untouched
    expect(issue.comments).toHaveLength(0);
    expect(loadState(paths.state).active).toBeNull();
  });
});
