import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig, requireApiKey } from './config.js';
import { LinearApi } from './linear.js';
import { runTick } from './tick.js';

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

  do {
    const outcome = await runTick({ config, linear, paths, log });
    log(`tick: ${outcome}`);
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
