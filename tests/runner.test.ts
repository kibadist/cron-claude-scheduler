import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, logTail } from '../src/runner.js';

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
