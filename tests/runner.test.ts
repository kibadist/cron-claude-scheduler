import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, logTail, buildArgs, isLimitError } from '../src/runner.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sched-runner-'));
  logPath = join(dir, 'run.log');
});

describe('runClaude', () => {
  it('captures output and a zero exit code', async () => {
    const result = await runClaude({
      command: join(FIXTURES, 'fake-claude-ok.sh'),
      prompt: 'do the thing',
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
    });
    expect(result).toEqual({ exitCode: 0, timedOut: false });
    expect(readFileSync(logPath, 'utf8')).toContain('claiming success');
  });

  it('reports a non-zero exit code and captures stderr', async () => {
    const result = await runClaude({
      command: join(FIXTURES, 'fake-claude-fail.sh'),
      prompt: 'do the thing',
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
    });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(logPath, 'utf8')).toContain('terribly wrong');
  });

  it('kills the process on timeout', async () => {
    const result = await runClaude({
      command: join(FIXTURES, 'fake-claude-slow.sh'),
      prompt: '',
      cwd: dir,
      timeoutMs: 500,
      logPath,
    });
    expect(result.timedOut).toBe(true);
  });

  it('resolves with null exit code when the command cannot be spawned', async () => {
    const result = await runClaude({
      command: '/nonexistent/claude',
      prompt: '',
      cwd: dir,
      timeoutMs: 1_000,
      logPath,
    });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('passes --model and extra args through to the command', async () => {
    const result = await runClaude({
      command: join(FIXTURES, 'fake-claude-args.sh'),
      prompt: '',
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
      model: 'opus',
      extraArgs: ['--verbose'],
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(logPath, 'utf8')).toContain(
      'args: -p --dangerously-skip-permissions --model opus --verbose',
    );
  });

  it('resolves instead of crashing when the log path is unwritable', async () => {
    const result = await runClaude({
      command: join(FIXTURES, 'fake-claude-ok.sh'),
      prompt: '',
      cwd: dir,
      timeoutMs: 10_000,
      logPath: join(dir, 'no-such-dir', 'run.log'),
    });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});

describe('buildArgs', () => {
  it('uses only the built-in flags by default', () => {
    expect(buildArgs({})).toEqual(['-p', '--dangerously-skip-permissions']);
  });

  it('appends --model then extra args, in that order', () => {
    expect(buildArgs({ model: 'sonnet', extraArgs: ['--foo', 'bar'] })).toEqual([
      '-p',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--foo',
      'bar',
    ]);
  });

  it('omits --model when unset and ignores an empty extraArgs array', () => {
    expect(buildArgs({ extraArgs: [] })).toEqual(['-p', '--dangerously-skip-permissions']);
  });
});

describe('isLimitError', () => {
  it('recognises the CLI usage/session/rate limit phrasings', () => {
    const limits = [
      "You've hit your session limit · resets 2pm (America/New_York)",
      'Claude usage limit reached. Your limit will reset at 6pm (UTC).',
      '5-hour limit reached ∙ resets 3pm',
      "You've reached your usage limit",
      'Error: rate limit exceeded',
      'Overloaded',
      'Your credit balance is too low',
      'out of credits',
    ];
    for (const msg of limits) expect(isLimitError(msg), msg).toBe(true);
  });

  it('does not treat a normal failure as a limit', () => {
    const notLimits = [
      'TypeError: cannot read property of undefined',
      'tests failed: 3 of 10',
      'the rate of progress was slow',
      'limit the scope of this change',
    ];
    for (const msg of notLimits) expect(isLimitError(msg), msg).toBe(false);
  });
});

describe('logTail', () => {
  it('returns the last N lines', async () => {
    await runClaude({
      command: join(FIXTURES, 'fake-claude-ok.sh'),
      prompt: '',
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
    });
    expect(logTail(logPath, 5)).toContain('claiming success');
  });

  it('handles a missing log file', () => {
    expect(logTail(join(dir, 'nope.log'))).toBe('(no log)');
  });
});
