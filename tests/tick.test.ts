import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTick, type TickPaths } from '../src/tick.js';
import { acquireLock } from '../src/lock.js';
import { loadState, saveState } from '../src/state.js';
import { remoteBranchExists } from '../src/verify.js';
import { commitAndPush, git, makeRepoPair } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config, GitFlow } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-tick-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string, claudeCommand: string, gitFlow: GitFlow = 'branch-push'): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: claudeCommand, timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [{ linearProject: 'Test Project', path: workspace, gitFlow, baseBranch: 'main' }],
  };
}

describe('runTick', () => {
  it('happy path: works the ticket, verifies the push, moves to In Review', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('claude/kib-1-add-hello-endpoint');
    expect(remoteBranchExists(workspace, 'claude/kib-1-add-hello-endpoint')).toBe(true);

    // the user's checkout was never touched: still on main, clean, no local
    // claude/ branch, no leftover worktrees
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(workspace, 'status', '--porcelain').trim()).toBe('');
    expect(git(workspace, 'branch', '--list', 'claude/*').trim()).toBe('');
    expect(git(workspace, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('returns idle when there are no eligible tickets', async () => {
    const { workspace } = makeRepoPair();
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    expect(await runTick({ config, linear: new FakeLinear(), paths })).toBe('idle');
  });

  it('claude failure: comments, moves back to Todo, skips until the ticket is touched', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-fail.sh'));

    expect(await runTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments.at(-1)).toContain('exited with code 1');
    expect(issue.comments.at(-1)).toContain('terribly wrong'); // log tail made it into the comment

    // Second tick: the ticket is skipped even though our own writes bumped updatedAt.
    expect(await runTick({ config, linear, paths })).toBe('idle');

    // The user touches the ticket -> eligible again.
    issue.ticket.updatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(await runTick({ config, linear, paths })).toBe('failure');
  });

  it('verification failure: claude exits 0 but pushed nothing', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-ok.sh'));

    expect(await runTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments.at(-1)).toContain('not pushed');
  });

  it('branch-pr: pushed branch without a PR is a failure', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'), 'branch-pr');

    expect(await runTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('no PR');
  });

  it('timeout: slow claude is killed and reported', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-slow.sh'));
    config.claude.timeoutMinutes = 0.01; // 600ms

    expect(await runTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('timed out');
  });

  it('downloads ticket images and hands them to claude as local files', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    const url = 'https://uploads.linear.app/abc/shot.png';
    linear.images.set(url, Buffer.from('fake-png-bytes'));
    linear.add(makeTicket({ description: `Make it look like ![shot](${url})` }));
    const paths = makePaths();
    const config = makeConfig(workspace, 'unused-command');

    let prompt = '';
    let imageContent = '';
    let imagePath = '';
    // Read the image WHILE claude runs: the disposable worktree (and its sibling
    // assets dir) is cleaned up once the tick finishes, so the file is gone after.
    const run = async (opts: { prompt: string }): Promise<{ exitCode: number; timedOut: boolean }> => {
      prompt = opts.prompt;
      imagePath = opts.prompt.match(/^- (\/.+image-1\.png)$/m)![1];
      imageContent = readFileSync(imagePath, 'utf8');
      return { exitCode: 1, timedOut: false }; // fail fast; we only care about the prompt
    };
    await runTick({ config, linear, paths, run: run as never });

    expect(prompt).toContain('Attached images');
    expect(prompt).not.toContain('uploads.linear.app'); // rewritten to a local path
    expect(imageContent).toBe('fake-png-bytes');
    expect(existsSync(imagePath)).toBe(false); // assets cleaned up with the worktree
  });

  it('a stale branch from a previous attempt does not pass verification', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, 'claude/kib-1-add-hello-endpoint', 'old.txt'); // previous attempt
    git(workspace, 'checkout', 'main');
    git(workspace, 'branch', '-D', 'claude/kib-1-add-hello-endpoint');
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-ok.sh')); // exit 0, pushes nothing

    expect(await runTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('was not updated');
  });

  it('usage limit: ticket returns to Todo unblamed and the scheduler pauses', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-limit.sh'));

    expect(await runTick({ config, linear, paths })).toBe('paused');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo'); // un-claimed
    expect(issue.comments).toHaveLength(0); // no failure comment — not the ticket's fault
    const state = loadState(paths.state);
    expect(state.skips).toEqual({}); // not skip-listed
    expect(state.pausedUntil! > new Date().toISOString()).toBe(true);

    // while paused, ticks do nothing at all (claude is never spawned)
    config.claude.command = '/nonexistent/claude';
    expect(await runTick({ config, linear, paths })).toBe('paused');

    // pause expired -> ticks resume
    const expired = loadState(paths.state);
    expired.pausedUntil = new Date(Date.now() - 1_000).toISOString();
    saveState(paths.state, expired);
    expect(await runTick({ config, linear, paths })).toBe('failure'); // spawn failure now, proving it ran
  });

  it('workspace prep failure: ticket goes back to Todo, never stuck In Progress', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));
    config.projects[0].baseBranch = 'no-such-branch'; // fetch will fail → addWorkWorktree throws

    expect(await runTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments.at(-1)).toContain('could not prepare the work workspace');
  });

  it('exits silently when another run holds the lock', async () => {
    const { workspace } = makeRepoPair();
    const paths = makePaths();
    acquireLock(paths.lock); // held by our own (alive) process
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    expect(await runTick({ config, linear: new FakeLinear(), paths })).toBe('locked');
  });

  it('recovers a ticket stuck In Progress from a dead run, then continues', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Progress'); // stuck from the dead run
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z' },
      skips: {},
      branches: {},
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.comments[0]).toContain('interrupted');
    expect(issue.status).toBe('In Review');
  });

  it('recovers a claim-phase crash: active set but ticket never left Todo', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    // The crash happened AFTER saveState but BEFORE moveIssue, so the ticket is
    // still in Todo in Linear even though state.active points at it.
    linear.add(makeTicket(), 'Todo');
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z' },
      skips: {},
      branches: {},
      retries: {},
      resolves: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.comments[0]).toContain('interrupted'); // recovery fired harmlessly
    expect(issue.status).toBe('In Review'); // then continued and succeeded
  });

  it('releases the lock and stays recoverable when the gateway throws mid-tick', async () => {
    const { workspace } = makeRepoPair();
    // Throws only on the In Review move, i.e. after the claim has been persisted.
    class ThrowingLinear extends FakeLinear {
      throwOnReview = true;
      async moveIssue(issueId: string, statusName: string): Promise<void> {
        if (this.throwOnReview && statusName === 'In Review') {
          throw new Error('Linear API exploded');
        }
        await super.moveIssue(issueId, statusName);
      }
    }
    const linear = new ThrowingLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    await expect(runTick({ config, linear, paths })).rejects.toThrow('Linear API exploded');

    // The lock must have been released despite the throw.
    expect(existsSync(paths.lock)).toBe(false);
    expect(acquireLock(paths.lock)).toBe(true);
    // (re-release so the next runTick can take it)
    const { releaseLock } = await import('../src/lock.js');
    releaseLock(paths.lock);

    // The ticket is now stuck In Progress with active still persisted.
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Progress');

    // Second tick with a healthy gateway recovers it. The branch already exists
    // on origin from the first run, so fake-claude-push.sh would fail to
    // re-create it — use fake-claude-fail.sh and accept a 'failure' outcome.
    // What matters is that recovery fired and the ticket left In Progress.
    linear.throwOnReview = false;
    const recoverConfig = makeConfig(workspace, join(FIXTURES, 'fake-claude-fail.sh'));

    await runTick({ config: recoverConfig, linear, paths });

    expect(issue.comments.some((c: string) => c.includes('interrupted'))).toBe(true);
    expect(issue.status).not.toBe('In Progress');
  });
});
