import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig, requireApiKey } from './config.js';
import { LinearApi } from './linear.js';
import { makeNotifier } from './notify.js';
import { processBotUpdates } from './bot.js';
import { runAutoTick, runReviewTick, runTick } from './tick.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const root = process.cwd();
  const config = loadConfig(resolve(root, process.env.CONFIG_PATH ?? 'config.json'));
  const linear = new LinearApi(requireApiKey());
  const paths = {
    lock: join(root, '.scheduler.lock'),
    state: join(root, '.state.json'),
    logsDir: join(root, 'logs'),
  };
  mkdirSync(paths.logsDir, { recursive: true });

  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const notify = makeNotifier(config, log);
  const loop = process.argv.includes('--loop');
  // Default: work the Todo queue, and verify In Review tickets when idle.
  // --work / --review restrict a run to a single mode.
  const [tick, label] = process.argv.includes('--review')
    ? ([runReviewTick, 'review tick'] as const)
    : process.argv.includes('--work')
      ? ([runTick, 'work tick'] as const)
      : ([runAutoTick, 'tick'] as const);

  // The Telegram control bot runs only as a long-lived loop with a telegram
  // channel: a background poller drains commands every few seconds — including
  // mid-tick, because the tick frees its lock during the claude run (see
  // releaseLockForBot). One-shot runs and non-telegram setups skip both.
  const botActive = loop && config.notifications?.type === 'telegram';
  let botBusy = false;
  if (botActive) {
    const timer = setInterval(() => {
      if (botBusy) return;
      botBusy = true;
      processBotUpdates({ config, paths, log })
        .catch((e: unknown) => log(`bot poll error: ${describeError(e)}`))
        .finally(() => {
          botBusy = false;
        });
    }, 8_000);
    timer.unref(); // the tick loop, not this timer, keeps the process alive
    log('Telegram control bot active (polling every 8s)');
  }

  do {
    log(`${label} starting (pid ${process.pid})`);
    try {
      const outcome = await tick({ config, linear, paths, log, notify, releaseLockForBot: botActive });
      log(`${label}: ${outcome}`);
    } catch (err) {
      // A transient Linear/network error must not kill the loop (or spew a
      // GraphQL stack): the tick released its lock in `finally`, any claimed
      // ticket is recovered by the next tick, so retrying is always safe.
      if (isTransientNetworkError(err)) {
        log(`${label} failed: ${describeError(err)} — will retry next tick`);
      } else {
        console.error(err);
        log(`${label} failed: ${describeError(err)} — will retry next tick`);
      }
      if (!loop) process.exitCode = 1;
    }
    if (loop) await sleep(config.pollIntervalMinutes * 60_000);
  } while (loop);
}

function isTransientNetworkError(err: unknown): boolean {
  const e = err as { type?: string; status?: number };
  if (e?.type === 'NetworkError') return true; // @linear/sdk NetworkLinearError
  return typeof e?.status === 'number' && (e.status === 429 || e.status >= 500);
}

function describeError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  const status = typeof e?.status === 'number' ? ` (HTTP ${e.status})` : '';
  const message = (e?.message ?? String(err)).split('\n')[0];
  return `${message}${status}`;
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
