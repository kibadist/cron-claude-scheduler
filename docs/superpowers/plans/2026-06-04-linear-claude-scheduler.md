# Linear → Claude Code Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A launchd-triggered one-shot scheduler that picks Todo tickets from configured Linear projects, runs `claude` headlessly in the mapped local git workspace, verifies the push, and moves the ticket to In Review (or comments + back to Todo on failure).

**Architecture:** Cron-style tick process: lockfile → recover interrupted work → poll Linear → claim one ticket → spawn `claude -p` → verify git push independently → finalize in Linear → exit. Small single-purpose modules wired together in `tick.ts`. State persists in `.state.json`; concurrency guarded by a PID lockfile.

**Tech Stack:** Node.js 24, TypeScript (ESM, NodeNext), `@linear/sdk`, `dotenv`, vitest. Integration tests use real temp git repos (bare "origin" + clone) and stub `claude` shell scripts — no real Linear API or tokens in tests.

**Spec:** `docs/superpowers/specs/2026-06-04-linear-claude-scheduler-design.md`

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example, config.example.json
src/
  types.ts     — shared types (Config, ProjectConfig, TicketInfo, ...)
  config.ts    — load + validate config.json and LINEAR_API_KEY
  lock.ts      — PID lockfile (acquire/release, stale detection)
  state.ts     — .state.json: active ticket + failed-ticket skip list
  prompt.ts    — branch naming + Claude prompt construction
  runner.ts    — spawn claude CLI, stream to log, timeout; logTail helper
  verify.ts    — git/gh post-run verification per gitFlow
  linear.ts    — LinearGateway interface + real @linear/sdk impl + ticket sorting
  tick.ts      — orchestrates one tick (the heart of the scheduler)
  index.ts     — CLI entrypoint (--loop flag)
tests/
  helpers/git.ts           — temp bare-origin + workspace repo pairs
  helpers/fake-linear.ts   — in-memory LinearGateway + makeTicket factory
  fixtures/fake-claude-*.sh — stub claude executables (ok/fail/slow/push)
  *.test.ts                — one test file per module
scripts/
  install-agent.sh, uninstall-agent.sh — launchd plist generation + bootstrap
logs/ (gitignored), README.md
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `config.example.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cron-claude-scheduler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "tick": "npm run build && node dist/index.js",
    "loop": "npm run build && node dist/index.js --loop",
    "install-agent": "npm run build && bash scripts/install-agent.sh",
    "uninstall-agent": "bash scripts/uninstall-agent.sh"
  }
}
```

- [ ] **Step 2: Install dependencies (let npm resolve current versions)**

Run: `npm install @linear/sdk dotenv && npm install -D typescript vitest @types/node`
Expected: `package.json` gains dependencies/devDependencies, `package-lock.json` created.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
logs/
.env
config.json
.state.json
.scheduler.lock
.omc/
```

- [ ] **Step 6: Create `.env.example`**

```
LINEAR_API_KEY=lin_api_your_key_here
```

- [ ] **Step 7: Create `config.example.json`**

```json
{
  "pollIntervalMinutes": 2,
  "claude": {
    "command": "claude",
    "timeoutMinutes": 60
  },
  "statuses": {
    "todo": "Todo",
    "inProgress": "In Progress",
    "inReview": "In Review"
  },
  "projects": [
    {
      "linearProject": "Kibadist Knowledge",
      "path": "/Users/kibadist/Code/kibadist-knowledge",
      "gitFlow": "branch-pr",
      "baseBranch": "main"
    },
    {
      "linearProject": "Detailing App",
      "path": "/Users/kibadist/Code/detailingApp/detailing-app",
      "gitFlow": "branch-push",
      "baseBranch": "main"
    }
  ]
}
```

- [ ] **Step 8: Verify the toolchain runs**

Run: `npx tsc --noEmit --version && npx vitest run`
Expected: TypeScript version prints; vitest exits with "No test files found" (that's fine at this stage — use `npx vitest run --passWithNoTests` if it exits non-zero).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example config.example.json
git commit -m "chore: scaffold TypeScript project with vitest"
```

---

### Task 2: Shared types + config loading/validation

**Files:**
- Create: `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Create `src/types.ts`** (pure types, no test needed)

```ts
export type GitFlow = 'branch-pr' | 'branch-push' | 'main-push';

export interface ProjectConfig {
  linearProject: string;
  path: string;
  gitFlow: GitFlow;
  baseBranch: string;
}

export interface ClaudeConfig {
  command: string;
  timeoutMinutes: number;
}

export interface StatusConfig {
  todo: string;
  inProgress: string;
  inReview: string;
}

export interface Config {
  pollIntervalMinutes: number;
  claude: ClaudeConfig;
  statuses: StatusConfig;
  projects: ProjectConfig[];
}

export interface TicketComment {
  author: string;
  body: string;
}

export interface TicketInfo {
  id: string; // Linear issue UUID
  identifier: string; // e.g. KIB-123
  title: string;
  description: string;
  comments: TicketComment[];
  priority: number; // 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  projectName: string;
}
```

- [ ] **Step 2: Write failing tests `tests/config.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
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
});

describe('requireApiKey', () => {
  it('throws when LINEAR_API_KEY is unset', () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => requireApiKey()).toThrow(/LINEAR_API_KEY/);
  });

  it('returns the key when set', () => {
    process.env.LINEAR_API_KEY = 'lin_api_test';
    expect(requireApiKey()).toBe('lin_api_test');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config, GitFlow, ProjectConfig } from './types.js';

const GIT_FLOWS: readonly GitFlow[] = ['branch-pr', 'branch-push', 'main-push'];

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(msg);
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) fail(`Config file not found: ${configPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`Config is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) fail('Config must be a JSON object');
  const c = raw as Record<string, unknown>;

  if (
    typeof c.pollIntervalMinutes !== 'number' ||
    !Number.isInteger(c.pollIntervalMinutes) ||
    c.pollIntervalMinutes <= 0
  )
    fail('pollIntervalMinutes must be a positive integer');

  const claude = c.claude as Record<string, unknown> | undefined;
  if (typeof claude !== 'object' || claude === null) fail('claude section is required');
  if (typeof claude.command !== 'string' || claude.command.length === 0)
    fail('claude.command must be a non-empty string');
  if (typeof claude.timeoutMinutes !== 'number' || claude.timeoutMinutes <= 0)
    fail('claude.timeoutMinutes must be a positive number');

  const statuses = c.statuses as Record<string, unknown> | undefined;
  if (typeof statuses !== 'object' || statuses === null) fail('statuses section is required');
  for (const key of ['todo', 'inProgress', 'inReview'] as const) {
    if (typeof statuses[key] !== 'string' || (statuses[key] as string).length === 0)
      fail(`statuses.${key} must be a non-empty string`);
  }

  if (!Array.isArray(c.projects) || c.projects.length === 0)
    fail('projects must be a non-empty array');
  const projects = (c.projects as unknown[]).map((p, i) => validateProject(p, i));

  return {
    pollIntervalMinutes: c.pollIntervalMinutes,
    claude: { command: claude.command as string, timeoutMinutes: claude.timeoutMinutes as number },
    statuses: {
      todo: statuses.todo as string,
      inProgress: statuses.inProgress as string,
      inReview: statuses.inReview as string,
    },
    projects,
  };
}

function validateProject(raw: unknown, index: number): ProjectConfig {
  const at = `projects[${index}]`;
  if (typeof raw !== 'object' || raw === null) fail(`${at} must be an object`);
  const p = raw as Record<string, unknown>;

  if (typeof p.linearProject !== 'string' || p.linearProject.length === 0)
    fail(`${at}.linearProject must be a non-empty string`);
  if (typeof p.path !== 'string' || !isAbsolute(p.path))
    fail(`${at}.path must be an absolute path`);
  if (!existsSync(p.path)) fail(`${at}.path does not exist: ${p.path}`);
  if (!existsSync(join(p.path, '.git'))) fail(`${at}.path is not a git repository: ${p.path}`);
  if (!GIT_FLOWS.includes(p.gitFlow as GitFlow))
    fail(`${at}.gitFlow must be one of: ${GIT_FLOWS.join(', ')}`);
  if (typeof p.baseBranch !== 'string' || p.baseBranch.length === 0)
    fail(`${at}.baseBranch must be a non-empty string`);

  return {
    linearProject: p.linearProject,
    path: p.path,
    gitFlow: p.gitFlow as GitFlow,
    baseBranch: p.baseBranch,
  };
}

export function requireApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new ConfigError('LINEAR_API_KEY is not set (put it in .env)');
  return key;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: config loading with validation"
```

---

### Task 3: PID lockfile

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

- [ ] **Step 1: Write failing tests `tests/lock.test.ts`**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lock.test.ts`
Expected: FAIL — cannot resolve `../src/lock.js`.

- [ ] **Step 3: Implement `src/lock.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lock.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat: PID lockfile with stale-lock detection"
```

---

### Task 4: Persistent state (skip list + active ticket)

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write failing tests `tests/state.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, isSkipped, type SchedulerState } from '../src/state.js';

let statePath: string;

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), 'sched-state-')), 'state.json');
});

describe('state persistence', () => {
  it('returns empty state when no file exists', () => {
    expect(loadState(statePath)).toEqual({ active: null, skips: {} });
  });

  it('round-trips state', () => {
    const state: SchedulerState = {
      active: { issueId: 'abc', identifier: 'KIB-1', startedAt: '2026-06-04T10:00:00.000Z' },
      skips: { abc: '2026-06-04T09:00:00.000Z' },
    };
    saveState(statePath, state);
    expect(loadState(statePath)).toEqual(state);
  });

  it('returns empty state for a corrupt file', () => {
    writeFileSync(statePath, '{corrupt');
    expect(loadState(statePath)).toEqual({ active: null, skips: {} });
  });
});

describe('isSkipped', () => {
  const base: SchedulerState = { active: null, skips: { 'issue-1': '2026-06-04T10:00:00.000Z' } };

  it('is not skipped when never failed', () => {
    expect(isSkipped(base, 'issue-2', '2026-06-04T10:00:00.000Z')).toBe(false);
  });

  it('is skipped when updatedAt has not moved past the recorded failure', () => {
    expect(isSkipped(base, 'issue-1', '2026-06-04T10:00:00.000Z')).toBe(true);
    expect(isSkipped(base, 'issue-1', '2026-06-04T09:59:59.000Z')).toBe(true);
  });

  it('is eligible again once the ticket was touched after the failure', () => {
    expect(isSkipped(base, 'issue-1', '2026-06-04T10:00:01.000Z')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/state.js`.

- [ ] **Step 3: Implement `src/state.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface ActiveTicket {
  issueId: string;
  identifier: string;
  startedAt: string;
}

export interface SchedulerState {
  active: ActiveTicket | null;
  /** issueId -> the ticket's updatedAt recorded right after our failure writes */
  skips: Record<string, string>;
}

const EMPTY: SchedulerState = { active: null, skips: {} };

export function loadState(statePath: string): SchedulerState {
  if (!existsSync(statePath)) return { ...EMPTY, skips: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SchedulerState>;
    return { active: raw.active ?? null, skips: raw.skips ?? {} };
  } catch {
    return { ...EMPTY, skips: {} };
  }
}

export function saveState(statePath: string, state: SchedulerState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function isSkipped(state: SchedulerState, issueId: string, updatedAt: string): boolean {
  const recordedAt = state.skips[issueId];
  if (!recordedAt) return false;
  // ISO 8601 strings compare correctly lexicographically.
  return updatedAt <= recordedAt;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: persistent state with failed-ticket skip list"
```

---

### Task 5: Branch naming + prompt building

**Files:**
- Create: `src/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write failing tests `tests/prompt.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { branchName, buildPrompt } from '../src/prompt.js';
import type { ProjectConfig, TicketInfo } from '../src/types.js';

function makeTicket(over: Partial<TicketInfo> = {}): TicketInfo {
  return {
    id: 'issue-1',
    identifier: 'KIB-12',
    title: 'Fix the Login!! Flow',
    description: 'Users cannot log in with Google.',
    comments: [],
    priority: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'Test Project',
    ...over,
  };
}

function makeProject(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    linearProject: 'Test Project',
    path: '/tmp/workspace',
    gitFlow: 'branch-pr',
    baseBranch: 'main',
    ...over,
  };
}

describe('branchName', () => {
  it('builds a slugged branch from identifier and title', () => {
    expect(branchName('KIB-12', 'Fix the Login!! Flow')).toBe('claude/kib-12-fix-the-login-flow');
  });

  it('truncates long titles to 30 slug chars without a trailing dash', () => {
    const branch = branchName('KIB-1', 'a very long ticket title that goes on and on forever');
    expect(branch.length).toBeLessThanOrEqual('claude/kib-1-'.length + 30);
    expect(branch.endsWith('-')).toBe(false);
  });

  it('handles a title with no usable characters', () => {
    expect(branchName('KIB-3', '!!!')).toBe('claude/kib-3');
  });
});

describe('buildPrompt', () => {
  it('includes ticket identifier, title, description and comments', () => {
    const prompt = buildPrompt(
      makeTicket({ comments: [{ author: 'Max', body: 'Please also check Safari' }] }),
      makeProject(),
      'claude/kib-12-fix-the-login-flow',
    );
    expect(prompt).toContain('KIB-12: Fix the Login!! Flow');
    expect(prompt).toContain('Users cannot log in with Google.');
    expect(prompt).toContain('**Max:** Please also check Safari');
  });

  it('includes PR instructions only for branch-pr', () => {
    const ticket = makeTicket();
    const branch = 'claude/kib-12-fix-the-login-flow';
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'branch-pr' }), branch)).toContain('gh pr create');
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'branch-push' }), branch)).not.toContain('gh pr create');
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'main-push' }), branch)).not.toContain('gh pr create');
  });

  it('tells branch flows the exact branch name', () => {
    const prompt = buildPrompt(makeTicket(), makeProject({ gitFlow: 'branch-push' }), 'claude/kib-12-x');
    expect(prompt).toContain('claude/kib-12-x');
  });

  it('tells main-push to work on the base branch', () => {
    const prompt = buildPrompt(makeTicket(), makeProject({ gitFlow: 'main-push', baseBranch: 'main' }), 'unused');
    expect(prompt).toContain('git push origin main');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — cannot resolve `../src/prompt.js`.

- [ ] **Step 3: Implement `src/prompt.ts`**

```ts
import type { ProjectConfig, TicketInfo } from './types.js';

export function branchName(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return `claude/${identifier.toLowerCase()}${slug ? `-${slug}` : ''}`;
}

function gitFlowInstructions(project: ProjectConfig, branch: string): string {
  switch (project.gitFlow) {
    case 'branch-pr':
      return [
        `1. Create and switch to a branch named exactly \`${branch}\` off \`${project.baseBranch}\`.`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push -u origin ${branch}\`.`,
        `5. Open a pull request with \`gh pr create\` targeting \`${project.baseBranch}\`; put the ticket ID in the PR title.`,
      ].join('\n');
    case 'branch-push':
      return [
        `1. Create and switch to a branch named exactly \`${branch}\` off \`${project.baseBranch}\`.`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push -u origin ${branch}\`. Do NOT open a pull request.`,
      ].join('\n');
    case 'main-push':
      return [
        `1. Work directly on \`${project.baseBranch}\`: make sure it is checked out and up to date (\`git pull origin ${project.baseBranch}\`).`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push: \`git push origin ${project.baseBranch}\`.`,
      ].join('\n');
  }
}

export function buildPrompt(ticket: TicketInfo, project: ProjectConfig, branch: string): string {
  const comments = ticket.comments.length
    ? ticket.comments.map((c) => `**${c.author}:** ${c.body}`).join('\n\n')
    : '_none_';

  return `You are working autonomously on a Linear ticket in this repository.

# Ticket ${ticket.identifier}: ${ticket.title}

## Description

${ticket.description || '_no description provided_'}

## Comments

${comments}

## Required workflow

${gitFlowInstructions(project, branch)}

## Rules

- You are unattended: do NOT ask questions. Make reasonable decisions and note them in commit messages.
- Run the project's existing test and lint commands before pushing; do not push failing work.
- If you cannot complete the task, do NOT push anything — explain the blocker in your final message and stop.
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat: branch naming and Claude prompt construction"
```

---

### Task 6: Claude runner (spawn, log, timeout)

**Files:**
- Create: `src/runner.ts`, `tests/fixtures/fake-claude-ok.sh`, `tests/fixtures/fake-claude-fail.sh`, `tests/fixtures/fake-claude-slow.sh`
- Test: `tests/runner.test.ts`

- [ ] **Step 1: Create the stub claude fixtures**

`tests/fixtures/fake-claude-ok.sh`:
```bash
#!/usr/bin/env bash
# Stub claude: consumes the prompt, claims success, pushes nothing.
cat > /dev/null
echo "did some thinking, claiming success without pushing"
exit 0
```

`tests/fixtures/fake-claude-fail.sh`:
```bash
#!/usr/bin/env bash
cat > /dev/null
echo "something went terribly wrong" >&2
exit 1
```

`tests/fixtures/fake-claude-slow.sh`:
```bash
#!/usr/bin/env bash
cat > /dev/null
exec sleep 30
```

Then run: `chmod +x tests/fixtures/fake-claude-*.sh`
(git preserves the executable bit on commit.)

- [ ] **Step 2: Write failing tests `tests/runner.test.ts`**

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL — cannot resolve `../src/runner.js`.

- [ ] **Step 4: Implement `src/runner.ts`**

```ts
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
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      log.end();
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, opts.timeoutMs);

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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/runner.test.ts`
Expected: PASS (6 tests). The timeout test takes ~0.5s; the rest are fast.

- [ ] **Step 6: Commit**

```bash
git add src/runner.ts tests/runner.test.ts tests/fixtures/fake-claude-ok.sh tests/fixtures/fake-claude-fail.sh tests/fixtures/fake-claude-slow.sh
git commit -m "feat: claude runner with logging and timeout"
```

---

### Task 7: Git verification

**Files:**
- Create: `src/verify.ts`, `tests/helpers/git.ts`
- Test: `tests/verify.test.ts`

- [ ] **Step 1: Create the git test helper `tests/helpers/git.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export interface RepoPair {
  /** bare repo acting as the remote ("origin") */
  origin: string;
  /** clone the scheduler will treat as the local workspace */
  workspace: string;
}

export function makeRepoPair(): RepoPair {
  const dir = mkdtempSync(join(tmpdir(), 'sched-git-'));
  const origin = join(dir, 'origin.git');
  const workspace = join(dir, 'workspace');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8' });
  execFileSync('git', ['clone', origin, workspace], { encoding: 'utf8' });
  git(workspace, 'config', 'user.email', 'test@test.local');
  git(workspace, 'config', 'user.name', 'Test');
  writeFileSync(join(workspace, 'README.md'), 'hello\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'init');
  git(workspace, 'push', 'origin', 'main');
  return { origin, workspace };
}

export function commitAndPush(workspace: string, branch: string, file: string): void {
  git(workspace, 'checkout', '-b', branch);
  writeFileSync(join(workspace, file), 'content\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', `add ${file}`);
  git(workspace, 'push', '-u', 'origin', branch);
}
```

- [ ] **Step 2: Write failing tests `tests/verify.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  remoteBranchExists,
  remoteHeadSha,
  prUrlForBranch,
  verifyWork,
} from '../src/verify.js';
import { makeRepoPair, commitAndPush, git } from './helpers/git.js';
import type { ProjectConfig } from '../src/types.js';

function project(workspace: string, gitFlow: ProjectConfig['gitFlow']): ProjectConfig {
  return { linearProject: 'X', path: workspace, gitFlow, baseBranch: 'main' };
}

describe('remoteBranchExists', () => {
  it('is false before push, true after', () => {
    const { workspace } = makeRepoPair();
    expect(remoteBranchExists(workspace, 'claude/kib-1-test')).toBe(false);
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    expect(remoteBranchExists(workspace, 'claude/kib-1-test')).toBe(true);
  });
});

describe('remoteHeadSha', () => {
  it('returns a sha that changes when the branch advances', () => {
    const { workspace } = makeRepoPair();
    const before = remoteHeadSha(workspace, 'main');
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(workspace, 'new.txt'), 'x\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'more');
    git(workspace, 'push', 'origin', 'main');

    const after = remoteHeadSha(workspace, 'main');
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('returns empty string for a missing branch', () => {
    const { workspace } = makeRepoPair();
    expect(remoteHeadSha(workspace, 'no-such-branch')).toBe('');
  });
});

describe('prUrlForBranch', () => {
  it('returns null when gh cannot find a PR (or is unavailable)', () => {
    const { workspace } = makeRepoPair();
    expect(prUrlForBranch(workspace, 'claude/kib-1-test')).toBeNull();
  });
});

describe('verifyWork', () => {
  it('branch-push: ok when the branch is on the remote', () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    const result = verifyWork(project(workspace, 'branch-push'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(true);
  });

  it('branch-push: fails when the branch was never pushed', () => {
    const { workspace } = makeRepoPair();
    const result = verifyWork(project(workspace, 'branch-push'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not pushed');
  });

  it('branch-pr: fails when the branch is pushed but no PR exists', () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    const result = verifyWork(project(workspace, 'branch-pr'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no PR');
  });

  it('main-push: ok only when the remote base branch advanced', () => {
    const { workspace } = makeRepoPair();
    const preSha = remoteHeadSha(workspace, 'main');

    const unchanged = verifyWork(project(workspace, 'main-push'), 'unused', preSha);
    expect(unchanged.ok).toBe(false);

    writeFileSync(join(workspace, 'new.txt'), 'x\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'work');
    git(workspace, 'push', 'origin', 'main');

    const changed = verifyWork(project(workspace, 'main-push'), 'unused', preSha);
    expect(changed.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/verify.test.ts`
Expected: FAIL — cannot resolve `../src/verify.js`.

- [ ] **Step 4: Implement `src/verify.ts`**

```ts
import { execFileSync } from 'node:child_process';
import type { ProjectConfig } from './types.js';

export interface VerifyResult {
  ok: boolean;
  detail: string;
  prUrl?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function remoteBranchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['ls-remote', '--heads', 'origin', branch]).trim().length > 0;
}

export function remoteHeadSha(cwd: string, branch: string): string {
  const out = git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`]).trim();
  return out.split('\t')[0] ?? '';
}

export function prUrlForBranch(cwd: string, branch: string): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // no PR, gh not installed, or repo not on GitHub
  }
}

export function verifyWork(project: ProjectConfig, branch: string, preRunSha: string): VerifyResult {
  switch (project.gitFlow) {
    case 'branch-push': {
      if (!remoteBranchExists(project.path, branch))
        return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      return { ok: true, detail: `branch \`${branch}\` pushed to origin` };
    }
    case 'branch-pr': {
      if (!remoteBranchExists(project.path, branch))
        return { ok: false, detail: `branch \`${branch}\` was not pushed to origin` };
      const prUrl = prUrlForBranch(project.path, branch);
      if (!prUrl) return { ok: false, detail: `branch \`${branch}\` was pushed but no PR was found` };
      return { ok: true, detail: `branch \`${branch}\` pushed, PR open`, prUrl };
    }
    case 'main-push': {
      const now = remoteHeadSha(project.path, project.baseBranch);
      if (!now || now === preRunSha)
        return { ok: false, detail: `remote \`${project.baseBranch}\` did not change — nothing was pushed` };
      return { ok: true, detail: `remote \`${project.baseBranch}\` advanced to ${now.slice(0, 8)}` };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/verify.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/verify.ts tests/verify.test.ts tests/helpers/git.ts
git commit -m "feat: git push verification per gitFlow"
```

---

### Task 8: Linear gateway

**Files:**
- Create: `src/linear.ts`, `tests/helpers/fake-linear.ts`
- Test: `tests/linear.test.ts`

The real `LinearApi` wraps `@linear/sdk` and is exercised manually in Task 12 (it is thin glue over the SDK). The pure sorting logic gets unit tests, and `FakeLinear` (used by Task 9's integration tests) implements the same interface.

- [ ] **Step 1: Write failing tests `tests/linear.test.ts`** (sorting logic only)

```ts
import { describe, it, expect } from 'vitest';
import { compareTickets } from '../src/linear.js';
import type { TicketInfo } from '../src/types.js';

function ticket(over: Partial<TicketInfo>): TicketInfo {
  return {
    id: 'x',
    identifier: 'X-1',
    title: 't',
    description: '',
    comments: [],
    priority: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'P',
    ...over,
  };
}

describe('compareTickets', () => {
  it('orders urgent (1) before low (4)', () => {
    const urgent = ticket({ priority: 1 });
    const low = ticket({ priority: 4 });
    expect([low, urgent].sort(compareTickets)[0]).toBe(urgent);
  });

  it('orders no-priority (0) last', () => {
    const none = ticket({ priority: 0 });
    const low = ticket({ priority: 4 });
    expect([none, low].sort(compareTickets)[0]).toBe(low);
  });

  it('breaks priority ties by oldest createdAt first', () => {
    const older = ticket({ priority: 2, createdAt: '2026-06-01T00:00:00.000Z' });
    const newer = ticket({ priority: 2, createdAt: '2026-06-02T00:00:00.000Z' });
    expect([newer, older].sort(compareTickets)[0]).toBe(older);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear.test.ts`
Expected: FAIL — cannot resolve `../src/linear.js`.

- [ ] **Step 3: Implement `src/linear.ts`**

```ts
import { LinearClient } from '@linear/sdk';
import type { TicketComment, TicketInfo } from './types.js';

export interface LinearGateway {
  /** Todo issues in the given projects, sorted by priority (urgent first, none last), then oldest first */
  fetchTodoIssues(projectNames: string[], todoStatus: string): Promise<TicketInfo[]>;
  moveIssue(issueId: string, statusName: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  getUpdatedAt(issueId: string): Promise<string>;
}

const NO_PRIORITY = 0;

export function compareTickets(a: TicketInfo, b: TicketInfo): number {
  const pa = a.priority === NO_PRIORITY ? 5 : a.priority;
  const pb = b.priority === NO_PRIORITY ? 5 : b.priority;
  if (pa !== pb) return pa - pb;
  return a.createdAt.localeCompare(b.createdAt);
}

export class LinearApi implements LinearGateway {
  private readonly client: LinearClient;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async fetchTodoIssues(projectNames: string[], todoStatus: string): Promise<TicketInfo[]> {
    const result = await this.client.issues({
      filter: {
        project: { name: { in: projectNames } },
        state: { name: { eqIgnoreCase: todoStatus } },
      },
      first: 50,
    });

    const tickets: TicketInfo[] = [];
    for (const issue of result.nodes) {
      const project = await issue.project;
      if (!project) continue;

      const commentsConn = await issue.comments();
      const comments: TicketComment[] = [];
      for (const c of commentsConn.nodes) {
        const user = await c.user;
        comments.push({ author: user?.name ?? 'unknown', body: c.body });
      }
      comments.reverse(); // Linear returns newest first; the prompt wants chronological order

      tickets.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        comments,
        priority: issue.priority,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
        projectName: project.name,
      });
    }
    return tickets.sort(compareTickets);
  }

  async moveIssue(issueId: string, statusName: string): Promise<void> {
    const issue = await this.client.issue(issueId);
    const team = await issue.team;
    if (!team) throw new Error(`Issue ${issueId} has no team`);
    const states = await team.states();
    const target = states.nodes.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
    if (!target) throw new Error(`Workflow state "${statusName}" not found in team "${team.name}"`);
    await this.client.updateIssue(issueId, { stateId: target.id });
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId, body });
  }

  async getUpdatedAt(issueId: string): Promise<string> {
    const issue = await this.client.issue(issueId);
    return issue.updatedAt.toISOString();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `tests/helpers/fake-linear.ts`** (used by Task 9)

```ts
import type { LinearGateway } from '../../src/linear.js';
import { compareTickets } from '../../src/linear.js';
import type { TicketInfo } from '../../src/types.js';

export interface FakeIssue {
  ticket: TicketInfo;
  status: string;
  comments: string[];
}

export function makeTicket(over: Partial<TicketInfo> = {}): TicketInfo {
  return {
    id: 'issue-1',
    identifier: 'KIB-1',
    title: 'Add hello endpoint',
    description: 'Make it say hello',
    comments: [],
    priority: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'Test Project',
    ...over,
  };
}

export class FakeLinear implements LinearGateway {
  readonly issues = new Map<string, FakeIssue>();

  add(ticket: TicketInfo, status = 'Todo'): void {
    this.issues.set(ticket.id, { ticket, status, comments: [] });
  }

  async fetchTodoIssues(projectNames: string[], todoStatus: string): Promise<TicketInfo[]> {
    const names = projectNames.map((n) => n.toLowerCase());
    return [...this.issues.values()]
      .filter((i) => i.status.toLowerCase() === todoStatus.toLowerCase())
      .filter((i) => names.includes(i.ticket.projectName.toLowerCase()))
      .map((i) => ({ ...i.ticket }))
      .sort(compareTickets);
  }

  async moveIssue(issueId: string, statusName: string): Promise<void> {
    this.get(issueId).status = statusName;
    this.touch(issueId);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    this.get(issueId).comments.push(body);
    this.touch(issueId);
  }

  async getUpdatedAt(issueId: string): Promise<string> {
    return this.get(issueId).ticket.updatedAt;
  }

  /** simulate Linear bumping updatedAt on every mutation (the trap the spec calls out) */
  private touch(issueId: string): void {
    const issue = this.get(issueId);
    issue.ticket.updatedAt = new Date(
      new Date(issue.ticket.updatedAt).getTime() + 1_000,
    ).toISOString();
  }

  private get(issueId: string): FakeIssue {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`no such issue: ${issueId}`);
    return issue;
  }
}
```

- [ ] **Step 6: Verify everything still compiles and passes**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean compile; all tests pass.
Note: `tsconfig.json` only includes `src/`; to typecheck tests too run `npx tsc --noEmit tests/helpers/fake-linear.ts` or rely on vitest.

- [ ] **Step 7: Commit**

```bash
git add src/linear.ts tests/linear.test.ts tests/helpers/fake-linear.ts
git commit -m "feat: Linear gateway with sorting and in-memory test fake"
```

---

### Task 9: Tick orchestration (integration tests)

**Files:**
- Create: `src/tick.ts`, `tests/fixtures/fake-claude-push.sh`
- Test: `tests/tick.test.ts`

- [ ] **Step 1: Create `tests/fixtures/fake-claude-push.sh`** — a stub claude that actually does the work: reads the prompt, extracts the branch name, commits and pushes.

```bash
#!/usr/bin/env bash
set -euo pipefail
PROMPT=$(cat)
BRANCH=$(echo "$PROMPT" | grep -oE 'claude/[a-z0-9-]+' | head -1)
git checkout -b "$BRANCH"
echo "work done" > claude-output.txt
git add claude-output.txt
git commit -m "work for $BRANCH"
git push -u origin "$BRANCH"
echo "pushed $BRANCH"
```

Then run: `chmod +x tests/fixtures/fake-claude-push.sh`

- [ ] **Step 2: Write failing tests `tests/tick.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTick, type TickPaths } from '../src/tick.js';
import { acquireLock } from '../src/lock.js';
import { saveState } from '../src/state.js';
import { remoteBranchExists } from '../src/verify.js';
import { makeRepoPair } from './helpers/git.js';
import { FakeLinear, makeTicket } from './helpers/fake-linear.js';
import type { Config, GitFlow } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function makePaths(): TickPaths {
  const dir = mkdtempSync(join(tmpdir(), 'sched-tick-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function makeConfig(workspace: string, claudeCommand: string, gitFlow: GitFlow = 'branch-push'): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: claudeCommand, timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review' },
    projects: [{ linearProject: 'Test Project', path: workspace, gitFlow, baseBranch: 'main' }],
  };
}

describe('runTick', () => {
  it('happy path: works the ticket, verifies the push, moves to In Review', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('In Review');
    expect(issue.comments.at(-1)).toContain('claude/kib-1-add-hello-endpoint');
    expect(remoteBranchExists(workspace, 'claude/kib-1-add-hello-endpoint')).toBe(true);
  });

  it('returns idle when there are no eligible tickets', async () => {
    const { workspace } = makeRepoPair();
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    expect(await runTick({ config, linear: new FakeLinear(), paths })).toBe('idle');
  });

  it('claude failure: comments, moves back to Todo, skips until the ticket is touched', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-fail.sh'));

    expect(await runTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments.at(-1)).toContain('exited with code 1');
    expect(issue.comments.at(-1)).toContain('terribly wrong'); // log tail made it into the comment

    // Second tick: the ticket is skipped even though our own writes bumped updatedAt.
    expect(await runTick({ config, linear, paths })).toBe('idle');

    // The user touches the ticket -> eligible again.
    issue.ticket.updatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(await runTick({ config, linear, paths })).toBe('failure');
  });

  it('verification failure: claude exits 0 but pushed nothing', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-ok.sh'));

    expect(await runTick({ config, linear, paths })).toBe('failure');
    const issue = linear.issues.get('issue-1')!;
    expect(issue.status).toBe('Todo');
    expect(issue.comments.at(-1)).toContain('not pushed');
  });

  it('branch-pr: pushed branch without a PR is a failure', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'), 'branch-pr');

    expect(await runTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('no PR');
  });

  it('timeout: slow claude is killed and reported', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket());
    const paths = makePaths();
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-slow.sh'));
    config.claude.timeoutMinutes = 0.01; // 600ms

    expect(await runTick({ config, linear, paths })).toBe('failure');
    expect(linear.issues.get('issue-1')!.comments.at(-1)).toContain('timed out');
  });

  it('exits silently when another run holds the lock', async () => {
    const { workspace } = makeRepoPair();
    const paths = makePaths();
    acquireLock(paths.lock); // held by our own (alive) process
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    expect(await runTick({ config, linear: new FakeLinear(), paths })).toBe('locked');
  });

  it('recovers a ticket stuck In Progress from a dead run, then continues', async () => {
    const { workspace } = makeRepoPair();
    const linear = new FakeLinear();
    linear.add(makeTicket(), 'In Progress'); // stuck from the dead run
    const paths = makePaths();
    saveState(paths.state, {
      active: { issueId: 'issue-1', identifier: 'KIB-1', startedAt: '2026-06-04T00:00:00.000Z' },
      skips: {},
    });
    const config = makeConfig(workspace, join(FIXTURES, 'fake-claude-push.sh'));

    const outcome = await runTick({ config, linear, paths });

    expect(outcome).toBe('success'); // recovered ticket became Todo and was picked up
    const issue = linear.issues.get('issue-1')!;
    expect(issue.comments[0]).toContain('interrupted');
    expect(issue.status).toBe('In Review');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/tick.test.ts`
Expected: FAIL — cannot resolve `../src/tick.js`.

- [ ] **Step 4: Implement `src/tick.ts`**

```ts
import { join } from 'node:path';
import type { Config, ProjectConfig } from './types.js';
import type { LinearGateway } from './linear.js';
import { acquireLock, releaseLock } from './lock.js';
import { isSkipped, loadState, saveState } from './state.js';
import { branchName, buildPrompt } from './prompt.js';
import { logTail, runClaude, type RunResult } from './runner.js';
import { remoteHeadSha, verifyWork, type VerifyResult } from './verify.js';

export type TickOutcome = 'locked' | 'idle' | 'success' | 'failure';

export interface TickPaths {
  lock: string;
  state: string;
  logsDir: string;
}

export interface TickDeps {
  config: Config;
  linear: LinearGateway;
  paths: TickPaths;
  /** injectable for tests; defaults to the real runner */
  run?: typeof runClaude;
  log?: (msg: string) => void;
}

export async function runTick(deps: TickDeps): Promise<TickOutcome> {
  const { config, linear, paths } = deps;
  const run = deps.run ?? runClaude;
  const log = deps.log ?? (() => {});

  if (!acquireLock(paths.lock)) return 'locked';
  try {
    const state = loadState(paths.state);

    // A successful or failed run always clears `active`, so if it's set while we
    // hold the lock, the previous run died mid-ticket. Recover it.
    if (state.active) {
      log(`recovering interrupted ticket ${state.active.identifier}`);
      await linear.addComment(
        state.active.issueId,
        `🤖 Scheduler: the previous run on this ticket was interrupted (crash or restart). Moving it back to ${config.statuses.todo}.`,
      );
      await linear.moveIssue(state.active.issueId, config.statuses.todo);
      state.active = null;
      saveState(paths.state, state);
    }

    const projectNames = config.projects.map((p) => p.linearProject);
    const issues = await linear.fetchTodoIssues(projectNames, config.statuses.todo);
    const eligible = issues.filter((t) => !isSkipped(state, t.id, t.updatedAt));
    if (eligible.length === 0) return 'idle';

    const ticket = eligible[0];
    const project = config.projects.find(
      (p) => p.linearProject.toLowerCase() === ticket.projectName.toLowerCase(),
    );
    if (!project) return 'idle'; // defensive: fetch is filtered to configured projects

    const branch = branchName(ticket.identifier, ticket.title);
    const preRunSha =
      project.gitFlow === 'main-push' ? remoteHeadSha(project.path, project.baseBranch) : '';

    log(`working ${ticket.identifier} in ${project.path}`);
    await linear.moveIssue(ticket.id, config.statuses.inProgress);
    state.active = {
      issueId: ticket.id,
      identifier: ticket.identifier,
      startedAt: new Date().toISOString(),
    };
    saveState(paths.state, state);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(paths.logsDir, `${ticket.identifier}-${stamp}.log`);
    const result = await run({
      command: config.claude.command,
      prompt: buildPrompt(ticket, project, branch),
      cwd: project.path,
      timeoutMs: config.claude.timeoutMinutes * 60_000,
      logPath,
    });

    const verdict = verdictFor(result, project, branch, preRunSha, config.claude.timeoutMinutes);

    if (verdict.ok) {
      await linear.addComment(ticket.id, successComment(verdict, branch, project));
      await linear.moveIssue(ticket.id, config.statuses.inReview);
      delete state.skips[ticket.id];
      state.active = null;
      saveState(paths.state, state);
      log(`done ${ticket.identifier}: ${verdict.detail}`);
      return 'success';
    }

    await linear.addComment(ticket.id, failureComment(verdict.detail, logTail(logPath)));
    await linear.moveIssue(ticket.id, config.statuses.todo);
    // Re-fetch updatedAt AFTER our own writes so our comment/move don't count as "user touched it".
    state.skips[ticket.id] = await linear.getUpdatedAt(ticket.id);
    state.active = null;
    saveState(paths.state, state);
    log(`failed ${ticket.identifier}: ${verdict.detail}`);
    return 'failure';
  } finally {
    releaseLock(paths.lock);
  }
}

function verdictFor(
  result: RunResult,
  project: ProjectConfig,
  branch: string,
  preRunSha: string,
  timeoutMinutes: number,
): VerifyResult {
  if (result.timedOut)
    return { ok: false, detail: `claude timed out after ${timeoutMinutes} minutes` };
  if (result.exitCode !== 0)
    return {
      ok: false,
      detail:
        result.exitCode === null
          ? 'claude could not be spawned (is it installed and on PATH?)'
          : `claude exited with code ${result.exitCode}`,
    };
  return verifyWork(project, branch, preRunSha);
}

function successComment(verdict: VerifyResult, branch: string, project: ProjectConfig): string {
  const lines = ['🤖 Scheduler: work completed and pushed.', '', `- ${verdict.detail}`];
  if (project.gitFlow !== 'main-push') lines.push(`- branch: \`${branch}\``);
  if (verdict.prUrl) lines.push(`- PR: ${verdict.prUrl}`);
  return lines.join('\n');
}

function failureComment(detail: string, tail: string): string {
  return [
    `🤖 Scheduler: run failed — ${detail}.`,
    '',
    'Last lines of the run log:',
    '```',
    tail,
    '```',
    '',
    'Edit or comment on this ticket to make it eligible for another attempt.',
  ].join('\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/tick.test.ts`
Expected: PASS (8 tests). The timeout test takes ~1s.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all test files pass.

- [ ] **Step 7: Commit**

```bash
git add src/tick.ts tests/tick.test.ts tests/fixtures/fake-claude-push.sh
git commit -m "feat: tick orchestration with recovery, verification and skip list"
```

---

### Task 10: CLI entrypoint

**Files:**
- Create: `src/index.ts`

No unit test — this is thin wiring over already-tested modules; it gets a smoke test below and a real run in Task 12.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
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
```

- [ ] **Step 2: Build and smoke-test config validation**

Run: `npm run build && node dist/index.js`
Expected: exits 1 with `Config error: Config file not found: .../config.json` (no `config.json` yet — that's the correct failure mode).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI entrypoint with --loop mode"
```

---

### Task 11: launchd integration + README

**Files:**
- Create: `scripts/install-agent.sh`, `scripts/uninstall-agent.sh`, `README.md`

- [ ] **Step 1: Create `scripts/install-agent.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.kibadist.claude-scheduler"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude || true)"
GH_BIN="$(command -v gh || true)"

if [[ ! -f "$REPO_DIR/config.json" ]]; then
  echo "config.json not found — copy config.example.json to config.json and edit it first" >&2
  exit 1
fi
if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  echo "dist/index.js not found — run: npm run build" >&2
  exit 1
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "warning: claude CLI not found on PATH — the scheduler will fail to spawn it" >&2
fi

INTERVAL_MIN="$("$NODE_BIN" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pollIntervalMinutes)" "$REPO_DIR/config.json")"
INTERVAL_SEC=$((INTERVAL_MIN * 60))

EXTRA_PATH="$(dirname "$NODE_BIN")"
[[ -n "$CLAUDE_BIN" ]] && EXTRA_PATH="$EXTRA_PATH:$(dirname "$CLAUDE_BIN")"
[[ -n "$GH_BIN" ]] && EXTRA_PATH="$EXTRA_PATH:$(dirname "$GH_BIN")"

mkdir -p "$REPO_DIR/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>StartInterval</key><integer>$INTERVAL_SEC</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REPO_DIR/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/logs/launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$EXTRA_PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed and started $LABEL (tick every $INTERVAL_MIN min)."
echo "Logs: $REPO_DIR/logs/launchd.log"
```

- [ ] **Step 2: Create `scripts/uninstall-agent.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
LABEL="com.kibadist.claude-scheduler"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL."
```

Then run: `chmod +x scripts/install-agent.sh scripts/uninstall-agent.sh`

- [ ] **Step 3: Verify the install script's guard rails (without installing)**

Run: `bash scripts/install-agent.sh`
Expected: exits 1 with "config.json not found" (config.json doesn't exist yet). This proves the guard works; actual installation happens in Task 12.

- [ ] **Step 4: Create `README.md`**

```markdown
# cron-claude-scheduler

Turns the **Todo** column of your Linear projects into a work queue for local
Claude Code agents. Every few minutes it picks one Todo ticket, runs `claude`
headlessly in the mapped local git workspace, verifies the work was pushed,
and moves the ticket to **In Review** — or comments and moves it back to
**Todo** on failure.

## Setup

1. `npm install && npm run build`
2. `cp .env.example .env` and set `LINEAR_API_KEY`
   (Linear → Settings → Security & access → Personal API keys)
3. `cp config.example.json config.json` and map your Linear projects to local
   git workspaces (see below)
4. Test one tick by hand: `npm run tick`
5. Install the launchd agent: `npm run install-agent`

## config.json

| Field | Meaning |
|---|---|
| `pollIntervalMinutes` | How often launchd fires a tick (positive integer) |
| `claude.command` | The claude CLI binary (usually just `claude`) |
| `claude.timeoutMinutes` | Kill a run that exceeds this |
| `statuses.*` | Workflow state names in your Linear team |
| `projects[].linearProject` | Linear project name (case-insensitive) |
| `projects[].path` | Absolute path to the local git workspace |
| `projects[].gitFlow` | `branch-pr` \| `branch-push` \| `main-push` |
| `projects[].baseBranch` | Branch to start from / push to |

### gitFlow

- **branch-pr** — work on `claude/<ticket>-<slug>`, push, open a PR with `gh`
- **branch-push** — same branch, push, no PR
- **main-push** — commit directly to `baseBranch` and push

## Daily operation

- A failed ticket gets a 🤖 comment with the log tail and goes back to Todo.
  It is **skipped** until you edit or comment on it — your touch means
  "try again".
- One ticket runs at a time, machine-wide (PID lockfile).
- Per-run logs: `logs/<TICKET>-<timestamp>.log`; launchd output: `logs/launchd.log`.
- Watch live: `npm run loop` (safe alongside launchd — the lockfile prevents overlap).
- Uninstall: `npm run uninstall-agent`.

## How verification works

The scheduler never trusts Claude's word. After a run it checks the remote:
branch flows must show the branch on `origin` (`git ls-remote`), `branch-pr`
must also have a PR (`gh pr view`), and `main-push` must have advanced the
remote base branch. Anything else is reported as a failure on the ticket.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/install-agent.sh scripts/uninstall-agent.sh README.md
git commit -m "feat: launchd install scripts and README"
```

---

### Task 12: Real-world smoke test (manual, with the user)

No code — this validates the glue that tests can't: the real Linear API and the real claude CLI. Requires the user's `LINEAR_API_KEY` and a sacrificial test ticket.

- [ ] **Step 1: Prepare**
  - `cp .env.example .env`, user fills in `LINEAR_API_KEY`
  - `cp config.example.json config.json`, user confirms project names/paths; consider pointing at a low-stakes repo first
  - Ask the user to create a small test ticket in Todo (e.g. "add a comment to the README")

- [ ] **Step 2: Run one tick in the foreground**

Run: `npm run tick`
Expected, in order: ticket moves to In Progress in Linear → claude works in the workspace (watch `logs/<TICKET>-*.log`) → branch appears on the remote → ticket moves to In Review with a 🤖 comment containing the branch/PR link.

- [ ] **Step 3: Verify the failure path**
  - Temporarily set `claude.timeoutMinutes` to something tiny (e.g. `0.1`) and create another test ticket
  - Run `npm run tick`; expected: ticket gets a 🤖 failure comment with the log tail and returns to Todo; a second `npm run tick` reports `idle` (skipped)
  - Restore the real timeout

- [ ] **Step 4: Install the agent**

Run: `npm run install-agent`
Expected: "Installed and started". Then `tail -f logs/launchd.log` and confirm a tick fires within the configured interval.

- [ ] **Step 5: Final commit if anything was adjusted**

```bash
git add -A && git status   # review; config.json/.env must NOT appear (gitignored)
git commit -m "chore: smoke-test adjustments"   # only if there are changes
```

---

## Self-review notes

- **Spec coverage:** config/auth (Tasks 1–2), lockfile + one-at-a-time (Task 3), skip list with post-write `updatedAt` (Tasks 4, 9), prompt + per-flow git instructions (Task 5), runner with timeout (Task 6), independent push verification incl. `main-push` pre-SHA and PR check (Task 7), Linear gateway + priority ordering (Task 8), lifecycle + recovery + comments (Task 9), `--loop` (Task 10), launchd + docs (Task 11), real-API validation (Task 12). The spec's "Linear API unreachable → log and exit, lock released" is covered by `runTick`'s `finally` + `main().catch` (Tasks 9–10).
- **Known simplification:** `statuses` are resolved per-issue-team by name at move time (Task 8 `moveIssue`), which matches the spec's "resolved to state IDs per team at runtime".
```
