import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewTick, type TickPaths } from '../src/tick.js';
import { loadState, saveState } from '../src/state.js';
import { MANUAL_PAUSE_UNTIL } from '../src/bot.js';
import type { RunOptions, RunResult } from '../src/runner.js';
import { makeRepoPair, commitAndPush } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config } from '../src/types.js';

const BRANCH = 'claude/kib-1-add-hello-endpoint';

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-lockrel-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: 'unused', timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [{ linearProject: 'Test Project', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main' }],
    maxRetries: 0,
  };
}

/** A fake claude run that, partway through, mutates the on-disk state the way
 * the bot poller would when a /pause arrives mid-run — then fails verification
 * (no VERDICT: PASS) so the tick takes its park path afterward. */
function pausingRun(paths: TickPaths): (opts: RunOptions) => Promise<RunResult> {
  return async (opts: RunOptions): Promise<RunResult> => {
    const s = loadState(paths.state);
    s.pausedUntil = MANUAL_PAUSE_UNTIL; // simulate /pause during the run
    saveState(paths.state, s);
    writeFileSync(opts.logPath, 'looked around, nothing conclusive\n');
    return { exitCode: 0, timedOut: false };
  };
}

describe('lock release during the claude run (bot responsiveness)', () => {
  it('with releaseLockForBot: preserves a mid-run bot mutation AND applies the outcome', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();

    const outcome = await runReviewTick({
      config: makeConfig(workspace),
      linear,
      paths,
      run: pausingRun(paths),
      releaseLockForBot: true,
    });

    expect(outcome).toBe('failure'); // verification failed → ticket parked
    const state = loadState(paths.state);
    expect(state.pausedUntil).toBe(MANUAL_PAUSE_UNTIL); // bot's /pause survived the reload-merge
    expect(state.skips['issue-1']).toBeDefined(); // and the park outcome was still applied
    expect(existsSync(paths.lock)).toBe(false); // lock released at the end
  });

  it('without the flag: the mid-run mutation is clobbered (shows why the flag exists)', async () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, BRANCH, 'work.txt');
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Review');
    const paths = makePaths();

    await runReviewTick({
      config: makeConfig(workspace),
      linear,
      paths,
      run: pausingRun(paths),
      // releaseLockForBot omitted → lock held throughout, no reload
    });

    // The tick never reloaded, so its final save overwrote the bot's pause.
    expect(loadState(paths.state).pausedUntil).toBeUndefined();
  });
});
