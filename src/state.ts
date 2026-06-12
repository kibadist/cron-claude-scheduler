import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface ActiveTicket {
  issueId: string;
  identifier: string;
  startedAt: string;
  /**
   * 'work' runs move the ticket to In Progress and must be moved back to Todo
   * if interrupted; 'review' runs never change the status, so an interrupted
   * one just clears. Absent in state files written before review mode existed.
   */
  mode?: 'work' | 'review';
}

export interface SchedulerState {
  active: ActiveTicket | null;
  /** issueId -> the ticket's updatedAt recorded right after our failure writes */
  skips: Record<string, string>;
  /** issueId -> branch pushed by a successful work run; lets the review tick
   * find the branch even when the ticket's title was edited afterwards */
  branches: Record<string, string>;
  /** set when claude hits its usage limit: ticks do nothing until this ISO
   * timestamp passes, so a drained quota can't burn through the Todo queue */
  pausedUntil?: string;
  /** issueId -> number of automatic re-implementation attempts triggered by
   * verification failures; cleared when the ticket reaches Done */
  retries: Record<string, number>;
  /** issueId -> number of automatic merge-conflict resolutions performed for a
   * verified-but-unmergeable PR; cleared when the ticket reaches Done */
  resolves: Record<string, number>;
}

export function loadState(statePath: string): SchedulerState {
  if (!existsSync(statePath))
    return { active: null, skips: {}, branches: {}, retries: {}, resolves: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SchedulerState>;
    return {
      active: raw.active ?? null,
      skips: raw.skips ?? {},
      branches: raw.branches ?? {},
      retries: raw.retries ?? {},
      resolves: raw.resolves ?? {},
      ...(raw.pausedUntil !== undefined && { pausedUntil: raw.pausedUntil }),
    };
  } catch {
    return { active: null, skips: {}, branches: {}, retries: {}, resolves: {} };
  }
}

export function saveState(statePath: string, state: SchedulerState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function isPaused(state: SchedulerState, now: Date = new Date()): boolean {
  return state.pausedUntil !== undefined && now.toISOString() < state.pausedUntil;
}

export function isSkipped(state: SchedulerState, issueId: string, updatedAt: string): boolean {
  const recordedAt = state.skips[issueId];
  if (!recordedAt) return false;
  // ISO 8601 strings compare correctly lexicographically.
  return updatedAt <= recordedAt;
}
