import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, requireApiKey } from '../src/config.js';

let dir: string;
let workspace: string;

function writeConfig(overrides: Record<string, unknown> = {}): string {
  const config = {
    pollIntervalMinutes: 2,
    claude: { command: 'claude', timeoutMinutes: 60 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review' },
    projects: [
      { linearProject: 'Test Project', path: workspace, gitFlow: 'branch-push', baseBranch: 'main' },
    ],
    ...overrides,
  };
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sched-config-'));
  workspace = join(dir, 'workspace');
  mkdirSync(join(workspace, '.git'), { recursive: true }); // looks like a git repo
});

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const config = loadConfig(writeConfig());
    expect(config.pollIntervalMinutes).toBe(2);
    expect(config.projects[0].gitFlow).toBe('branch-push');
  });

  it('rejects a missing file', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(ConfigError);
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/not found/);
  });

  it('rejects invalid JSON', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{nope');
    expect(() => loadConfig(path)).toThrow(/valid JSON/);
  });

  it('rejects a non-integer poll interval', () => {
    expect(() => loadConfig(writeConfig({ pollIntervalMinutes: 1.5 }))).toThrow(/positive integer/);
  });

  it('rejects an unknown gitFlow', () => {
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [{ linearProject: 'X', path: workspace, gitFlow: 'yolo', baseBranch: 'main' }],
        }),
      ),
    ).toThrow(/gitFlow/);
  });

  it('rejects a project path that does not exist', () => {
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [
            { linearProject: 'X', path: join(dir, 'missing'), gitFlow: 'branch-push', baseBranch: 'main' },
          ],
        }),
      ),
    ).toThrow(/does not exist/);
  });

  it('rejects a project path that is not a git repo', () => {
    const notGit = join(dir, 'not-git');
    mkdirSync(notGit);
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [{ linearProject: 'X', path: notGit, gitFlow: 'branch-push', baseBranch: 'main' }],
        }),
      ),
    ).toThrow(/not a git repository/);
  });

  it('rejects an empty projects array', () => {
    expect(() => loadConfig(writeConfig({ projects: [] }))).toThrow(/non-empty array/);
  });

  it('defaults maxRetries to 1 and validates it', () => {
    expect(loadConfig(writeConfig()).maxRetries).toBe(1);
    expect(loadConfig(writeConfig({ maxRetries: 0 })).maxRetries).toBe(0);
    expect(() => loadConfig(writeConfig({ maxRetries: -1 }))).toThrow(/maxRetries/);
    expect(() => loadConfig(writeConfig({ maxRetries: 1.5 }))).toThrow(/maxRetries/);
  });

  it('defaults maxMergeResolves to 1 and validates it', () => {
    expect(loadConfig(writeConfig()).maxMergeResolves).toBe(1);
    expect(loadConfig(writeConfig({ maxMergeResolves: 0 })).maxMergeResolves).toBe(0);
    expect(() => loadConfig(writeConfig({ maxMergeResolves: -1 }))).toThrow(/maxMergeResolves/);
    expect(() => loadConfig(writeConfig({ maxMergeResolves: 2.5 }))).toThrow(/maxMergeResolves/);
  });

  it('defaults autonomy and validates its fields', () => {
    const a = loadConfig(writeConfig()).autonomy!;
    expect(a).toEqual({
      circuitBreakerThreshold: 3,
      haltCooldownMinutes: 60,
      transientCooldownMinutes: 15,
      maxTransientRetries: 4,
    });
    expect(loadConfig(writeConfig({ autonomy: { circuitBreakerThreshold: 0 } })).autonomy!.circuitBreakerThreshold).toBe(0);
    expect(loadConfig(writeConfig({ autonomy: { maxTransientRetries: 2 } })).autonomy!.maxTransientRetries).toBe(2);
    expect(() => loadConfig(writeConfig({ autonomy: { circuitBreakerThreshold: -1 } }))).toThrow(/circuitBreakerThreshold/);
    expect(() => loadConfig(writeConfig({ autonomy: { haltCooldownMinutes: 0 } }))).toThrow(/haltCooldownMinutes/);
    expect(() => loadConfig(writeConfig({ autonomy: { transientCooldownMinutes: 1.5 } }))).toThrow(/transientCooldownMinutes/);
    expect(() => loadConfig(writeConfig({ autonomy: 'nope' }))).toThrow(/autonomy/);
  });

  it('validates notifications and leaves them undefined by default', () => {
    expect(loadConfig(writeConfig()).notifications).toBeUndefined();
    expect(loadConfig(writeConfig({ notifications: { type: 'slack', url: 'https://hooks.slack.com/x' } })).notifications).toEqual({
      type: 'slack',
      url: 'https://hooks.slack.com/x',
    });
    expect(
      loadConfig(writeConfig({ notifications: { type: 'telegram', telegram: { botToken: 'T', chatId: '1' } } }))
        .notifications,
    ).toEqual({ type: 'telegram', telegram: { botToken: 'T', chatId: '1' } });
    expect(() => loadConfig(writeConfig({ notifications: { type: 'carrier-pigeon' } }))).toThrow(/notifications.type/);
    expect(() => loadConfig(writeConfig({ notifications: { type: 'slack', url: 'ftp://x' } }))).toThrow(/url/);
    expect(() => loadConfig(writeConfig({ notifications: { type: 'telegram' } }))).toThrow(/telegram/);
  });

  it('leaves model/args undefined by default and validates them', () => {
    const base = loadConfig(writeConfig());
    expect(base.claude.model).toBeUndefined();
    expect(base.claude.args).toBeUndefined();
    expect(base.projects[0].model).toBeUndefined();

    const set = loadConfig(
      writeConfig({
        claude: { command: 'claude', timeoutMinutes: 60, model: 'opus', args: ['--verbose'] },
        projects: [
          { linearProject: 'X', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main', model: 'sonnet' },
        ],
      }),
    );
    expect(set.claude.model).toBe('opus');
    expect(set.claude.args).toEqual(['--verbose']);
    expect(set.projects[0].model).toBe('sonnet');
  });

  it('rejects malformed model/args', () => {
    expect(() =>
      loadConfig(writeConfig({ claude: { command: 'claude', timeoutMinutes: 60, model: '' } })),
    ).toThrow(/claude.model/);
    expect(() =>
      loadConfig(writeConfig({ claude: { command: 'claude', timeoutMinutes: 60, args: 'opus' } })),
    ).toThrow(/claude.args/);
    expect(() =>
      loadConfig(writeConfig({ claude: { command: 'claude', timeoutMinutes: 60, args: [1] } })),
    ).toThrow(/claude.args/);
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [{ linearProject: 'X', path: workspace, gitFlow: 'branch-push', baseBranch: 'main', model: '' }],
        }),
      ),
    ).toThrow(/model/);
  });

  it('defaults mergeOnVerified to false and accepts it on branch-pr', () => {
    expect(loadConfig(writeConfig()).projects[0].mergeOnVerified).toBe(false);
    const path = writeConfig({
      projects: [
        { linearProject: 'X', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main', mergeOnVerified: true },
      ],
    });
    expect(loadConfig(path).projects[0].mergeOnVerified).toBe(true);
  });

  it('rejects mergeOnVerified on flows without a PR', () => {
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [
            { linearProject: 'X', path: workspace, gitFlow: 'branch-push', baseBranch: 'main', mergeOnVerified: true },
          ],
        }),
      ),
    ).toThrow(/requires gitFlow "branch-pr"/);
  });

  it('rejects duplicate linearProject names (case-insensitive)', () => {
    expect(() =>
      loadConfig(
        writeConfig({
          projects: [
            { linearProject: 'Same', path: workspace, gitFlow: 'branch-push', baseBranch: 'main' },
            { linearProject: 'same', path: workspace, gitFlow: 'branch-pr', baseBranch: 'main' },
          ],
        }),
      ),
    ).toThrow(/duplicate linearProject/);
  });
});

describe('requireApiKey', () => {
  const original = process.env.LINEAR_API_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = original;
  });

  it('throws when LINEAR_API_KEY is unset', () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => requireApiKey()).toThrow(/LINEAR_API_KEY/);
  });

  it('returns the key when set', () => {
    process.env.LINEAR_API_KEY = 'lin_api_test';
    expect(requireApiKey()).toBe('lin_api_test');
  });
});
