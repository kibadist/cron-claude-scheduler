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

export function loadState(statePath: string): SchedulerState {
  if (!existsSync(statePath)) return { active: null, skips: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SchedulerState>;
    return { active: raw.active ?? null, skips: raw.skips ?? {} };
  } catch {
    return { active: null, skips: {} };
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
