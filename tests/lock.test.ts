import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, isPidAlive } from '../src/lock.js';

let lockPath: string;

beforeEach(() => {
  lockPath = join(mkdtempSync(join(tmpdir(), 'sched-lock-')), 'lock');
});

describe('lock', () => {
  it('acquires when no lockfile exists, writing our pid', () => {
    expect(acquireLock(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('refuses when the lock is held by a live process', () => {
    writeFileSync(lockPath, String(process.pid)); // we are definitely alive
    expect(acquireLock(lockPath)).toBe(false);
  });

  it('takes over a stale lock from a dead process', () => {
    const dead = spawnSync('true'); // runs and exits immediately
    writeFileSync(lockPath, String(dead.pid));
    expect(acquireLock(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('takes over a lock with garbage content', () => {
    writeFileSync(lockPath, 'not-a-pid');
    expect(acquireLock(lockPath)).toBe(true);
  });

  it('releases the lock', () => {
    acquireLock(lockPath);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release is a no-op when no lock exists', () => {
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});

describe('isPidAlive', () => {
  it('detects our own process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('detects a dead process', () => {
    const dead = spawnSync('true');
    expect(isPidAlive(dead.pid!)).toBe(false);
  });
});
