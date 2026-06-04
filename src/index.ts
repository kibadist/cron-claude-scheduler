import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig, requireApiKey } from './config.js';
import { LinearApi } from './linear.js';
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
  const loop = process.argv.includes('--loop');
  // Default: work the Todo queue, and verify In Review tickets when idle.
  // --work / --review restrict a run to a single mode.
  const [tick, label] = process.argv.includes('--review')
    ? ([runReviewTick, 'review tick'] as const)
    : process.argv.includes('--work')
      ? ([runTick, 'work tick'] as const)
      : ([runAutoTick, 'tick'] as const);

  do {
    log(`${label} starting (pid ${process.pid})`);
    const outcome = await tick({ config, linear, paths, log });
    log(`${label}: ${outcome}`);
    if (loop) await sleep(config.pollIntervalMinutes * 60_000);
  } while (loop);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
