import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';

export interface RunResult {
  /** null when the process could not be spawned at all */
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  command: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  logPath: string;
}

export function runClaude(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    const child = spawn(opts.command, ['-p', '--dangerously-skip-permissions'], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      log.end();
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      sigkillTimer.unref();
    }, opts.timeoutMs);

    // A bad logPath or full disk must fail the run, not crash the scheduler.
    log.on('error', () => {
      child.kill('SIGKILL');
      finish({ exitCode: null, timedOut: false });
    });

    child.stdout.on('data', (d: Buffer) => log.write(d));
    child.stderr.on('data', (d: Buffer) => log.write(d));

    child.on('error', (err) => {
      log.write(`\n[scheduler] failed to spawn ${opts.command}: ${err.message}\n`);
      finish({ exitCode: null, timedOut: false });
    });
    child.on('close', (code) => finish({ exitCode: code, timedOut }));

    child.stdin.on('error', () => {
      /* EPIPE when the child dies before reading the prompt — already handled via close */
    });
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

export function logTail(logPath: string, maxLines = 30): string {
  if (!existsSync(logPath)) return '(no log)';
  const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
  return lines.slice(-maxLines).join('\n');
}
