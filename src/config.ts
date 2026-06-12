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
  if (
    claude.limitCooldownMinutes !== undefined &&
    (typeof claude.limitCooldownMinutes !== 'number' || claude.limitCooldownMinutes <= 0)
  )
    fail('claude.limitCooldownMinutes must be a positive number when set');
  if (claude.model !== undefined && (typeof claude.model !== 'string' || claude.model.length === 0))
    fail('claude.model must be a non-empty string when set');
  if (
    claude.args !== undefined &&
    (!Array.isArray(claude.args) || claude.args.some((a) => typeof a !== 'string'))
  )
    fail('claude.args must be an array of strings when set');

  const statuses = c.statuses as Record<string, unknown> | undefined;
  if (typeof statuses !== 'object' || statuses === null) fail('statuses section is required');
  for (const key of ['todo', 'inProgress', 'inReview'] as const) {
    if (typeof statuses[key] !== 'string' || (statuses[key] as string).length === 0)
      fail(`statuses.${key} must be a non-empty string`);
  }
  // Optional with a default so configs written before review mode keep working.
  if (statuses.done !== undefined && (typeof statuses.done !== 'string' || statuses.done.length === 0))
    fail('statuses.done must be a non-empty string when set');

  if (
    c.maxRetries !== undefined &&
    (typeof c.maxRetries !== 'number' || !Number.isInteger(c.maxRetries) || c.maxRetries < 0)
  )
    fail('maxRetries must be a non-negative integer when set');

  if (
    c.maxMergeResolves !== undefined &&
    (typeof c.maxMergeResolves !== 'number' ||
      !Number.isInteger(c.maxMergeResolves) ||
      c.maxMergeResolves < 0)
  )
    fail('maxMergeResolves must be a non-negative integer when set');

  if (!Array.isArray(c.projects) || c.projects.length === 0)
    fail('projects must be a non-empty array');
  const projects = (c.projects as unknown[]).map((p, i) => validateProject(p, i));

  const names = projects.map((p) => p.linearProject.toLowerCase());
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) fail(`projects contains duplicate linearProject name: ${dup}`);

  return {
    pollIntervalMinutes: c.pollIntervalMinutes,
    claude: {
      command: claude.command as string,
      timeoutMinutes: claude.timeoutMinutes as number,
      limitCooldownMinutes: (claude.limitCooldownMinutes as number | undefined) ?? 30,
      model: claude.model as string | undefined,
      args: claude.args as string[] | undefined,
    },
    statuses: {
      todo: statuses.todo as string,
      inProgress: statuses.inProgress as string,
      inReview: statuses.inReview as string,
      done: (statuses.done as string | undefined) ?? 'Done',
    },
    projects,
    maxRetries: (c.maxRetries as number | undefined) ?? 1,
    maxMergeResolves: (c.maxMergeResolves as number | undefined) ?? 1,
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
  if (p.mergeOnVerified !== undefined && typeof p.mergeOnVerified !== 'boolean')
    fail(`${at}.mergeOnVerified must be a boolean`);
  if (p.mergeOnVerified === true && p.gitFlow !== 'branch-pr')
    fail(`${at}.mergeOnVerified requires gitFlow "branch-pr" (there is no PR to merge otherwise)`);
  if (p.model !== undefined && (typeof p.model !== 'string' || p.model.length === 0))
    fail(`${at}.model must be a non-empty string when set`);

  return {
    linearProject: p.linearProject,
    path: p.path,
    gitFlow: p.gitFlow as GitFlow,
    baseBranch: p.baseBranch,
    mergeOnVerified: (p.mergeOnVerified as boolean | undefined) ?? false,
    model: p.model as string | undefined,
  };
}

export function requireApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new ConfigError('LINEAR_API_KEY is not set (put it in .env)');
  return key;
}
