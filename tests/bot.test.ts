import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processBotUpdates, MANUAL_PAUSE_UNTIL, type TgUpdate, type TelegramClient } from '../src/bot.js';
import { loadState, saveState, type SchedulerState } from '../src/state.js';
import type { Config } from '../src/types.js';

const CHAT = '4242';

function makePaths(): { lock: string; state: string; logsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sched-bot-'));
  const paths = { lock: join(dir, '.lock'), state: join(dir, '.state.json'), logsDir: join(dir, 'logs') };
  mkdirSync(paths.logsDir);
  return paths;
}

function config(type: 'telegram' | 'slack' = 'telegram'): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: 'x', timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [],
    notifications:
      type === 'telegram'
        ? { type: 'telegram', telegram: { botToken: 'TOK', chatId: CHAT } }
        : { type: 'slack', url: 'https://hooks.slack.com/x' },
  };
}

function seed(state: string, over: Partial<SchedulerState>): void {
  saveState(state, { ...loadState(state), ...over });
}

function fakeClient(updates: TgUpdate[]): {
  sent: { chatId: string; text: string }[];
  acks: { id: string; text?: string }[];
  offsets: number[];
  client: TelegramClient;
} {
  const sent: { chatId: string; text: string }[] = [];
  const acks: { id: string; text?: string }[] = [];
  const offsets: number[] = [];
  return {
    sent,
    acks,
    offsets,
    client: {
      async getUpdates(offset: number): Promise<TgUpdate[]> {
        offsets.push(offset);
        // serve each update only once: hide any whose id is below the cursor
        return updates.filter((u) => u.update_id >= offset);
      },
      async sendMessage(chatId: string, text: string): Promise<void> {
        sent.push({ chatId, text });
      },
      async answerCallback(id: string, text?: string): Promise<void> {
        acks.push({ id, text });
      },
    },
  };
}

const msg = (id: number, text: string, chat: string = CHAT): TgUpdate => ({
  update_id: id,
  message: { chat: { id: chat }, text },
});
const tap = (id: number, data: string, chat: string = CHAT): TgUpdate => ({
  update_id: id,
  callback_query: { id: `cb-${id}`, data, message: { chat: { id: chat } } },
});

describe('processBotUpdates', () => {
  it('does nothing when the channel is not telegram', async () => {
    const paths = makePaths();
    const { client, sent } = fakeClient([msg(1, '/status')]);
    await processBotUpdates({ config: config('slack'), paths, client });
    expect(sent).toEqual([]);
  });

  it('/status reports active, paused and parked counts', async () => {
    const paths = makePaths();
    seed(paths.state, {
      active: { issueId: 'i1', identifier: 'DET-1', startedAt: 't', mode: 'work' },
      skips: { i1: 'ts', i2: 'ts' },
      cooldowns: { i3: { until: 'soon', count: 1 } },
    });
    const { client, sent } = fakeClient([msg(7, '/status')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: CHAT });
    expect(sent[0].text).toContain('DET-1');
    expect(sent[0].text).toContain('Parked: 2');
    expect(sent[0].text).toContain('Cooling: 1');
  });

  it('/retry <identifier> clears that ticket and resolves the label', async () => {
    const paths = makePaths();
    seed(paths.state, { skips: { i1: 'ts' }, labels: { i1: 'DET-9' } });
    const { client, sent } = fakeClient([msg(3, '/retry DET-9')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(loadState(paths.state).skips).toEqual({});
    expect(sent[0].text).toContain('Re-queued DET-9');
  });

  it('/retry reports when nothing matches', async () => {
    const paths = makePaths();
    const { client, sent } = fakeClient([msg(3, '/retry NOPE-1')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(sent[0].text).toContain('No parked or cooling ticket');
  });

  it('/retryall clears every skip and cooldown', async () => {
    const paths = makePaths();
    seed(paths.state, { skips: { i1: 'ts', i2: 'ts' }, cooldowns: { i3: { until: 's', count: 1 } } });
    const { client, sent } = fakeClient([msg(5, '/retryall')]);
    await processBotUpdates({ config: config(), paths, client });
    const s = loadState(paths.state);
    expect(s.skips).toEqual({});
    expect(s.cooldowns).toEqual({});
    expect(sent[0].text).toContain('3 tickets');
  });

  it('/pause sets the manual-pause sentinel and /resume clears it + the breaker', async () => {
    const paths = makePaths();
    seed(paths.state, { consecutiveFailures: 2 });

    await processBotUpdates({ config: config(), paths, client: fakeClient([msg(1, '/pause')]).client });
    expect(loadState(paths.state).pausedUntil).toBe(MANUAL_PAUSE_UNTIL);

    await processBotUpdates({ config: config(), paths, client: fakeClient([msg(2, '/resume')]).client });
    const s = loadState(paths.state);
    expect(s.pausedUntil).toBeUndefined();
    expect(s.consecutiveFailures).toBe(0);
  });

  it('handles an inline-button tap (callback) and acks it', async () => {
    const paths = makePaths();
    seed(paths.state, { skips: { i1: 'ts' }, labels: { i1: 'DET-2' } });
    const { client, sent, acks } = fakeClient([tap(8, 'retry:i1')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(loadState(paths.state).skips).toEqual({});
    expect(acks).toHaveLength(1);
    expect(acks[0].id).toBe('cb-8');
    expect(sent[0].text).toContain('Re-queued DET-2');
  });

  it('ignores updates from an unauthorized chat but still advances the offset', async () => {
    const paths = makePaths();
    seed(paths.state, { skips: { i1: 'ts' }, labels: { i1: 'DET-1' } });
    const { client, sent } = fakeClient([msg(11, '/retryall', '9999')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(loadState(paths.state).skips).toEqual({ i1: 'ts' }); // untouched
    expect(sent).toEqual([]); // no reply to a stranger
    expect(loadState(paths.state).telegramOffset).toBe(12); // offset moved past it
  });

  it('processes each update exactly once across calls (offset cursor)', async () => {
    const paths = makePaths();
    seed(paths.state, { skips: { i1: 'ts' }, labels: { i1: 'DET-1' } });
    const fc = fakeClient([msg(20, '/retryall')]);
    await processBotUpdates({ config: config(), paths, client: fc.client });
    expect(loadState(paths.state).telegramOffset).toBe(21);
    // second round: same update is now below the cursor -> not re-served, no reply
    await processBotUpdates({ config: config(), paths, client: fc.client });
    expect(fc.sent).toHaveLength(1);
    expect(fc.offsets).toEqual([0, 21]);
  });

  it('/help lists the commands', async () => {
    const paths = makePaths();
    const { client, sent } = fakeClient([msg(1, '/help')]);
    await processBotUpdates({ config: config(), paths, client });
    expect(sent[0].text).toContain('/retry');
    expect(sent[0].text).toContain('/pause');
  });
});
