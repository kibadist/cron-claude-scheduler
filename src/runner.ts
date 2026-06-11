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
  /** passed to claude as `--model <model>` when set; the bare CLI default
   * is used otherwise */
  model?: string;
  /** extra CLI flags appended after the built-in ones (escape hatch) */
  extraArgs?: string[];
}

/** Build the argv for a claude run. Exported for unit testing the flag order. */
export function buildArgs(opts: Pick<RunOptions, 'model' | 'extraArgs'>): string[] {
  const args = ['-p', '--dangerously-skip-permissions'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

export function runClaude(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    const child = spawn(opts.command, buildArgs(opts), {
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

/** Does the run output look like an account/usage limit rather than a real
 * failure of the ticket? Limit hits must pause the scheduler, not blame the
 * ticket. Covers the several phrasings the CLI uses, e.g.
 *   "Claude usage limit reached. Your limit will reset at 6pm (UTC)."
 *   "You've hit your session limit · resets 2pm (America/New_York)"
 *   "5-hour limit reached ∙ resets 3pm" */
export function isLimitError(logText: string): boolean {
  return /usage limit|session limit|limit reached|reached your (?:usage|session )?limit|limit\b[^.\n]{0,15}\bresets?\b|rate.?limit|overloaded|credit balance|out of credits/i.test(
    logText,
  );
}

export function logTail(logPath: string, maxLines = 30): string {
  if (!existsSync(logPath)) return '(no log)';
  const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
  return lines.slice(-maxLines).join('\n');
}
