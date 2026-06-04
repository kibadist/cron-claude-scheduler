import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTick, type TickPaths } from '../src/tick.js';
import { acquireLock } from '../src/lock.js';
import { saveState } from '../src/state.js';
import { remoteBranchExists } from '../src/verify.js';
import { makeRepoPair } from './helpers/git.js';
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
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review' },
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
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.comments[0]).toContain('interrupted');
    expect(issue.status).toBe('In Review');
  });
});
