import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewTick, type TickPaths } from '../src/tick.js';
import { loadState } from '../src/state.js';
import type { Notifier } from '../src/notify.js';
import { git, makeRepoPair, commitAndPush } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BRANCH = 'claude/kib-1-add-hello-endpoint';

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-autonomy-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string, claudeCommand: string, over: Partial<Config> = {}): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: claudeCommand, timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [{ linearProject: 'Test Project', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main' }],
    maxRetries: 0,
    ...over,
  };
}

function fakeNotifier(): { sent: string[]; notifier: Notifier } {
  const sent: string[] = [];
  return {
    sent,
    notifier: {
      async send(text: string): Promise<void> {
        sent.push(text);
      },
    },
  };
}

describe('autonomy: transient routing', () => {
  it('a transient verification failure cools down instead of burning a retry', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    // maxRetries 1: a GENUINE failure would consume a retry; a transient one must not.
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-transient.sh'), { maxRetries: 1 });
    const { notifier, sent } = fakeNotifier();

    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('failure');

    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review'); // not sent back to Todo, not moved
    expect(issue.comments.at(-1)).toContain('transient');

    const state = loadState(paths.state);
    expect(state.retries['issue-1']).toBeUndefined(); // retry budget untouched
    expect(state.cooldowns['issue-1']?.count).toBe(1); // backed off instead
    expect(state.skips['issue-1']).toBeUndefined(); // NOT parked for a human
    expect(sent).toEqual([]); // a transient hiccup is not escalated on its own

    // While the cooldown holds, the ticket is not picked up again.
    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('idle');
  });
});

describe('autonomy: escalation', () => {
  it('escalates when a ticket is genuinely parked', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-fail.sh'));
    const { notifier, sent } = fakeNotifier();

    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('failure');

    expect(loadState(paths.state).skips['issue-1']).toBeDefined(); // parked
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('KIB-1');
    expect(sent[0]).toContain('parked');
  });
});

describe('autonomy: circuit breaker', () => {
  it('halts and escalates after the threshold of consecutive failures', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt'); // KIB-1 branch
    commitAndPush(workspace, 'claude/kib-2-second-thing', 'work2.txt'); // KIB-2 branch
    git(workspace, 'checkout', 'main');

    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review'); // issue-1 / KIB-1
    linear.add(makeTicket({ id: 'issue-2', identifier: 'KIB-2', title: 'Second thing' }), 'In Review');

    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-fail.sh'), {
      autonomy: { circuitBreakerThreshold: 2, haltCooldownMinutes: 30 },
    });
    const { notifier, sent } = fakeNotifier();

    // Two distinct tickets fail in a row → the breaker trips on the second.
    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('failure');
    expect(loadState(paths.state).consecutiveFailures).toBe(1);

    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('failure');
    const tripped = loadState(paths.state);
    expect(tripped.pausedUntil).toBeDefined(); // halted
    expect(tripped.consecutiveFailures).toBe(0); // reset after tripping
    expect(sent.some((m) => /circuit breaker/i.test(m))).toBe(true);

    // While halted, the next tick does no work.
    expect(await runReviewTick({ config, linear, paths, notify: notifier })).toBe('paused');
  });

  it('a success clears the consecutive-failure streak', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-verify-pass.sh'));

    expect(await runReviewTick({ config, linear, paths })).toBe('success');
    expect(loadState(paths.state).consecutiveFailures).toBe(0);
  });
});
