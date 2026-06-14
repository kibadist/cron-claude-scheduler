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
  /** issueId -> a transient/environmental backoff: the ticket is skipped until
   * `until` passes (auto-lifts, no human touch), `count` bounds how many such
   * cycles it gets before the failure is escalated as genuine */
  cooldowns: Record<string, { until: string; count: number }>;
  /** consecutive failures across all tickets; trips the circuit breaker at the
   * configured threshold and resets to 0 on any success/resolution */
  consecutiveFailures: number;
  /** issueId -> the ticket's human identifier (e.g. "DET-343"), recorded for any
   * ticket the scheduler touches so the Telegram bot can list/resolve tickets
   * by identifier without a Linear round-trip; pruned when the ticket is Done */
  labels: Record<string, string>;
  /** Telegram getUpdates cursor: the next update_id to fetch, so bot commands
   * are processed exactly once across ticks */
  telegramOffset?: number;
}

/** A fresh empty state — MUST be a factory, not a shared const spread shallowly:
 * a shallow copy would alias the nested `skips`/`cooldowns`/… maps across every
 * caller, so one tick's writes would leak into the next tick's "empty" state. */
function emptyState(): SchedulerState {
  return {
    active: null,
    skips: {},
    branches: {},
    retries: {},
    resolves: {},
    cooldowns: {},
    consecutiveFailures: 0,
    labels: {},
  };
}

export function loadState(statePath: string): SchedulerState {
  if (!existsSync(statePath)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SchedulerState>;
    return {
      active: raw.active ?? null,
      skips: raw.skips ?? {},
      branches: raw.branches ?? {},
      retries: raw.retries ?? {},
      resolves: raw.resolves ?? {},
      cooldowns: raw.cooldowns ?? {},
      consecutiveFailures: raw.consecutiveFailures ?? 0,
      labels: raw.labels ?? {},
      ...(raw.pausedUntil !== undefined && { pausedUntil: raw.pausedUntil }),
      ...(raw.telegramOffset !== undefined && { telegramOffset: raw.telegramOffset }),
    };
  } catch {
    return emptyState();
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

/** Is the ticket in a transient-failure backoff that hasn't elapsed yet? Unlike
 * a skip, this auto-lifts once `until` passes — no human touch required. */
export function isCoolingDown(state: SchedulerState, issueId: string, now: Date = new Date()): boolean {
  const cd = state.cooldowns[issueId];
  return cd !== undefined && now.toISOString() < cd.until;
}
