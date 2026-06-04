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
    expect(loadState(statePath)).toEqual({ active: null, skips: {}, branches: {} });
  });

  it('round-trips state', () => {
    const state: SchedulerState = {
      active: { issueId: 'abc', identifier: 'KIB-1', startedAt: '2026-06-04T10:00:00.000Z' },
      skips: { abc: '2026-06-04T09:00:00.000Z' },
      branches: { abc: 'claude/kib-1-something' },
    };
    saveState(statePath, state);
    expect(loadState(statePath)).toEqual(state);
  });

  it('returns empty state for a corrupt file', () => {
    writeFileSync(statePath, '{corrupt');
    expect(loadState(statePath)).toEqual({ active: null, skips: {}, branches: {} });
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
