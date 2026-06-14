import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, isSkipped, isCoolingDown, type SchedulerState } from '../src/state.js';

let statePath: string;

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), 'sched-state-')), 'state.json');
});

const EMPTY = {
  active: null,
  skips: {},
  branches: {},
  retries: {},
  resolves: {},
  cooldowns: {},
  consecutiveFailures: 0,
  labels: {},
};

describe('state persistence', () => {
  it('returns empty state when no file exists', () => {
    expect(loadState(statePath)).toEqual(EMPTY);
  });

  it('round-trips state', () => {
    const state: SchedulerState = {
      active: { issueId: 'abc', identifier: 'KIB-1', startedAt: '2026-06-04T10:00:00.000Z' },
      skips: { abc: '2026-06-04T09:00:00.000Z' },
      branches: { abc: 'claude/kib-1-something' },
      retries: { abc: 1 },
      resolves: { abc: 2 },
      cooldowns: { abc: { until: '2026-06-04T10:15:00.000Z', count: 1 } },
      consecutiveFailures: 2,
      labels: { abc: 'KIB-1' },
      telegramOffset: 12345,
    };
    saveState(statePath, state);
    expect(loadState(statePath)).toEqual(state);
  });

  it('returns empty state for a corrupt file', () => {
    writeFileSync(statePath, '{corrupt');
    expect(loadState(statePath)).toEqual(EMPTY);
  });

  it('does not alias nested maps between two empty loads', () => {
    // Regression: a shared empty-state object spread shallowly would leak one
    // load's writes into the next. Each load must get its own nested objects.
    const a = loadState(statePath);
    a.skips['x'] = 'now';
    a.cooldowns['x'] = { until: 'soon', count: 1 };
    a.consecutiveFailures = 5;
    const b = loadState(join(mkdtempSync(join(tmpdir(), 'sched-state2-')), 'state.json'));
    expect(b.skips).toEqual({});
    expect(b.cooldowns).toEqual({});
    expect(b.consecutiveFailures).toBe(0);
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

describe('isCoolingDown', () => {
  const state = { ...EMPTY, cooldowns: { 'issue-1': { until: '2026-06-04T10:00:00.000Z', count: 1 } } } as SchedulerState;

  it('is false for a ticket with no cooldown', () => {
    expect(isCoolingDown(state, 'issue-2', new Date('2026-06-04T09:00:00.000Z'))).toBe(false);
  });

  it('is true before the cooldown elapses, false after (auto-lifts)', () => {
    expect(isCoolingDown(state, 'issue-1', new Date('2026-06-04T09:59:59.000Z'))).toBe(true);
    expect(isCoolingDown(state, 'issue-1', new Date('2026-06-04T10:00:01.000Z'))).toBe(false);
  });
});
