import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(lockPath: string, pid: number = process.pid): boolean {
  if (existsSync(lockPath)) {
    const existing = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (!Number.isNaN(existing) && isPidAlive(existing)) return false;
    // Stale or garbage lock — take it over.
  }
  writeFileSync(lockPath, String(pid));
  return true;
}

export function releaseLock(lockPath: string): void {
  if (existsSync(lockPath)) unlinkSync(lockPath);
}
