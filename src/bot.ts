import { acquireLock, releaseLock } from './lock.js';
import { isPaused, loadState, saveState, type SchedulerState } from './state.js';
import type { Config } from './types.js';
import type { TickPaths } from './tick.js';

/** Far-future sentinel for a manual /pause: reuses the existing `pausedUntil`
 * gate (isPaused), so a hand-paused scheduler stays paused until /resume clears
 * it. Distinguishable from a limit/breaker pause by its value. */
export const MANUAL_PAUSE_UNTIL = '2999-01-01T00:00:00.000Z';

/** The slice of the Telegram getUpdates payload we use. */
export interface TgUpdate {
  update_id: number;
  message?: { chat?: { id: number | string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat?: { id: number | string } } };
}

/** Minimal Telegram surface, injectable so tests never hit the network. */
export interface TelegramClient {
  getUpdates(offset: number): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

export interface BotDeps {
  config: Config;
  paths: TickPaths;
  /** injectable for tests; defaults to a fetch-based client from config creds */
  client?: TelegramClient;
  log?: (msg: string) => void;
}

const HELP = [
  'Scheduler bot commands:',
  '/status — what is running, paused, parked, cooling',
  '/parked — list tickets parked or cooling down',
  '/retry <DET-123> — re-queue one parked ticket',
  '/retryall — re-queue every parked/cooling ticket',
  '/pause — stop all ticks',
  '/resume — resume ticks (also clears a breaker halt)',
].join('\n');

/** Drain pending Telegram commands/taps and apply them to the scheduler state.
 * Called once per tick (before the work/review tick). Best-effort and bounded:
 * network failures are swallowed, only the configured chat is honoured, and each
 * update is processed exactly once via the persisted offset. */
export async function processBotUpdates(deps: BotDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const cfg = deps.config.notifications;
  if (!cfg || cfg.type !== 'telegram') return; // bot only runs for a telegram channel
  const client = deps.client ?? makeTelegramClient(cfg.telegram!.botToken, log);
  const authorizedChat = String(cfg.telegram!.chatId);

  const offset = loadState(deps.paths.state).telegramOffset ?? 0;
  const updates = await client.getUpdates(offset);
  if (updates.length === 0) return;

  // Mutate state under the lock so a concurrent tick can't clobber our writes.
  if (!acquireLock(deps.paths.lock)) {
    log('bot: tick in progress, will process Telegram updates next round');
    return;
  }
  const replies: { chatId: string; text: string }[] = [];
  const callbackAcks: { id: string; toast?: string }[] = [];
  try {
    const state = loadState(deps.paths.state);
    let maxId = offset - 1;
    for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      maxId = Math.max(maxId, u.update_id);
      const isCallback = u.callback_query !== undefined;
      const chat = isCallback ? u.callback_query?.message?.chat?.id : u.message?.chat?.id;
      const raw = isCallback ? u.callback_query?.data : u.message?.text;
      if (chat === undefined || String(chat) !== authorizedChat) continue; // ignore everyone else
      if (typeof raw !== 'string' || raw.length === 0) continue;

      const reply = applyAction(state, raw, isCallback);
      replies.push({ chatId: String(chat), text: reply });
      if (isCallback) callbackAcks.push({ id: u.callback_query!.id, toast: firstLine(reply) });
    }
    state.telegramOffset = maxId + 1;
    saveState(deps.paths.state, state);
  } finally {
    releaseLock(deps.paths.lock);
  }

  // Network I/O happens after the lock is released, so replies never block a tick.
  for (const ack of callbackAcks) await client.answerCallback(ack.id, ack.toast);
  for (const r of replies) await client.sendMessage(r.chatId, r.text);
}

/** Parse a command or callback into a state mutation, returning the reply text.
 * Pure aside from mutating `state` — the heart of the bot, fully unit-testable. */
function applyAction(state: SchedulerState, raw: string, isCallback: boolean): string {
  if (isCallback) {
    const [verb, arg] = splitOnce(raw, ':');
    switch (verb) {
      case 'retry':
        return retryOne(state, arg);
      case 'retryall':
        return retryAll(state);
      case 'pause':
        return pause(state);
      case 'resume':
        return resume(state);
      case 'status':
        return status(state);
      case 'parked':
        return parked(state);
      default:
        return `Unknown action: ${raw}`;
    }
  }
  // text command, e.g. "/retry DET-3" or "/status@MyBot"
  const [head, ...rest] = raw.trim().split(/\s+/);
  const cmd = head.replace(/@.*$/, '').toLowerCase();
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/retry':
      return arg ? retryOne(state, arg) : 'Usage: /retry <DET-123>';
    case '/retryall':
      return retryAll(state);
    case '/pause':
      return pause(state);
    case '/resume':
      return resume(state);
    case '/status':
      return status(state);
    case '/parked':
      return parked(state);
    case '/start':
    case '/help':
      return HELP;
    default:
      return `Unknown command: ${cmd}\n\n${HELP}`;
  }
}

function retryOne(state: SchedulerState, key: string): string {
  const id = resolveTicketId(state, key);
  if (!id) return `No parked or cooling ticket matching "${key}".`;
  const label = state.labels[id] ?? id;
  const had = state.skips[id] !== undefined || state.cooldowns[id] !== undefined;
  delete state.skips[id];
  delete state.cooldowns[id];
  return had
    ? `🔁 Re-queued ${label} — it will be picked up on the next tick.`
    : `${label} was not parked; nothing to clear.`;
}

function retryAll(state: SchedulerState): string {
  const ids = new Set([...Object.keys(state.skips), ...Object.keys(state.cooldowns)]);
  if (ids.size === 0) return 'Nothing is parked or cooling down.';
  state.skips = {};
  state.cooldowns = {};
  return `🔁 Re-queued ${ids.size} ticket${ids.size === 1 ? '' : 's'} — they will be picked up on the next ticks.`;
}

function pause(state: SchedulerState): string {
  state.pausedUntil = MANUAL_PAUSE_UNTIL;
  return '⏸ Scheduler paused. Send /resume to continue.';
}

function resume(state: SchedulerState): string {
  const wasPaused = state.pausedUntil !== undefined;
  delete state.pausedUntil;
  state.consecutiveFailures = 0; // also lifts a circuit-breaker halt
  return wasPaused ? '▶️ Scheduler resumed.' : '▶️ Scheduler was already running.';
}

function status(state: SchedulerState): string {
  const lines: string[] = [];
  lines.push(state.active ? `▶️ Working ${state.active.identifier} (${state.active.mode ?? 'work'})` : '💤 Idle');
  // Only report a pause that is still in effect — a past `pausedUntil` lingers in
  // state after the scheduler has already auto-resumed, and must not read as paused.
  if (isPaused(state)) {
    lines.push(
      state.pausedUntil === MANUAL_PAUSE_UNTIL
        ? '⏸ Manually paused (send /resume)'
        : `⏸ Paused until ${state.pausedUntil}`,
    );
  }
  const parkedN = Object.keys(state.skips).length;
  const coolingN = Object.keys(state.cooldowns).length;
  lines.push(`🛑 Parked: ${parkedN}   ❄️ Cooling: ${coolingN}   🔁 Retrying: ${Object.keys(state.retries).length}`);
  if (state.consecutiveFailures > 0) lines.push(`⚠️ Consecutive failures: ${state.consecutiveFailures}`);
  return lines.join('\n');
}

function parked(state: SchedulerState): string {
  const skipped = Object.keys(state.skips);
  const cooling = Object.keys(state.cooldowns);
  if (skipped.length === 0 && cooling.length === 0) return 'Nothing is parked or cooling down. 🎉';
  const lines: string[] = [];
  if (skipped.length > 0) {
    lines.push('🛑 Parked (need a human / retry):');
    for (const id of skipped) lines.push(`  • ${state.labels[id] ?? id}`);
  }
  if (cooling.length > 0) {
    lines.push('❄️ Cooling down (auto-retries):');
    for (const id of cooling) lines.push(`  • ${state.labels[id] ?? id} — until ${state.cooldowns[id].until}`);
  }
  lines.push('', 'Send /retry <id> or /retryall.');
  return lines.join('\n');
}

/** Map a user-typed key (identifier like "DET-3", or a raw issueId) to an
 * issueId the state knows about. Identifier match is case-insensitive. */
function resolveTicketId(state: SchedulerState, key: string): string | undefined {
  if (state.skips[key] !== undefined || state.cooldowns[key] !== undefined || state.labels[key] !== undefined)
    return key; // already an issueId
  const wanted = key.toLowerCase();
  for (const [id, label] of Object.entries(state.labels)) {
    if (label.toLowerCase() === wanted) return id;
  }
  return undefined;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

function firstLine(s: string): string {
  return s.split('\n')[0];
}

/** Real fetch-based Telegram client. All calls are best-effort: getUpdates
 * returns [] on failure (so the bot no-ops), sends swallow errors. */
export function makeTelegramClient(botToken: string, log: (msg: string) => void = () => {}): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;
  async function call(method: string, payload: Record<string, unknown>): Promise<{ result?: unknown }> {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`telegram ${method} HTTP ${res.status}`);
    return (await res.json()) as { result?: unknown };
  }
  return {
    async getUpdates(offset: number): Promise<TgUpdate[]> {
      try {
        const j = await call('getUpdates', {
          offset,
          timeout: 0,
          allowed_updates: ['message', 'callback_query'],
        });
        return (j.result ?? []) as TgUpdate[];
      } catch (e) {
        log(`telegram getUpdates failed: ${(e as Error).message}`);
        return [];
      }
    },
    async sendMessage(chatId: string, text: string): Promise<void> {
      try {
        await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      } catch (e) {
        log(`telegram sendMessage failed: ${(e as Error).message}`);
      }
    },
    async answerCallback(callbackId: string, text?: string): Promise<void> {
      try {
        await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
      } catch {
        /* a missed callback ack just shows a spinner briefly; never fatal */
      }
    },
  };
}
