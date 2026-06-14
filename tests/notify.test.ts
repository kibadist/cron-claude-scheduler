import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeNotifier, logOnlyNotifier } from '../src/notify.js';
import type { Config } from '../src/types.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(ok = true): { url: string; body: unknown }[] {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok } as Response;
  }) as typeof fetch;
  return calls;
}

function cfg(notifications?: Config['notifications']): Config {
  return {
    pollIntervalMinutes: 1,
    claude: { command: 'x', timeoutMinutes: 1 },
    statuses: { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done' },
    projects: [],
    ...(notifications && { notifications }),
  };
}

describe('makeNotifier', () => {
  it('posts {text} to a slack webhook', async () => {
    const calls = captureFetch();
    await makeNotifier(cfg({ type: 'slack', url: 'https://hooks.slack.com/x' })).send('hello');
    expect(calls).toEqual([{ url: 'https://hooks.slack.com/x', body: { text: 'hello' } }]);
  });

  it('posts {content} to a discord webhook', async () => {
    const calls = captureFetch();
    await makeNotifier(cfg({ type: 'discord', url: 'https://discord.com/api/webhooks/x' })).send('hi');
    expect(calls[0].body).toEqual({ content: 'hi' });
  });

  it('posts chat_id + text to the telegram bot API', async () => {
    const calls = captureFetch();
    await makeNotifier(
      cfg({ type: 'telegram', telegram: { botToken: 'TOK', chatId: '42' } }),
    ).send('ping');
    expect(calls[0].url).toBe('https://api.telegram.org/botTOK/sendMessage');
    expect(calls[0].body).toMatchObject({ chat_id: '42', text: 'ping' });
  });

  it('renders inline-keyboard buttons for telegram', async () => {
    const calls = captureFetch();
    await makeNotifier(cfg({ type: 'telegram', telegram: { botToken: 'TOK', chatId: '42' } })).send('parked', [
      { label: 'Retry', data: 'retry:i1' },
      { label: 'Pause', data: 'pause' },
    ]);
    expect(calls[0].body).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Retry', callback_data: 'retry:i1' }],
          [{ text: 'Pause', callback_data: 'pause' }],
        ],
      },
    });
  });

  it('ignores buttons for non-telegram channels', async () => {
    const calls = captureFetch();
    await makeNotifier(cfg({ type: 'slack', url: 'https://hooks.slack.com/x' })).send('parked', [
      { label: 'Retry', data: 'retry:i1' },
    ]);
    expect(calls[0].body).toEqual({ text: 'parked' }); // no reply_markup
  });

  it('sends both keys to a generic webhook', async () => {
    const calls = captureFetch();
    await makeNotifier(cfg({ type: 'webhook', url: 'https://example.com/hook' })).send('yo');
    expect(calls[0].body).toEqual({ text: 'yo', content: 'yo' });
  });

  it('is log-only (no fetch) when no channel is configured', async () => {
    const logs: string[] = [];
    globalThis.fetch = vi.fn() as typeof fetch;
    await makeNotifier(cfg(), (m) => logs.push(m)).send('nobody home');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('nobody home');
  });

  it('never throws when delivery fails (HTTP error)', async () => {
    const logs: string[] = [];
    captureFetch(false); // res.ok === false
    await expect(
      makeNotifier(cfg({ type: 'slack', url: 'https://hooks.slack.com/x' }), (m) => logs.push(m)).send('x'),
    ).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('notification delivery failed');
  });

  it('never throws when fetch itself rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      makeNotifier(cfg({ type: 'slack', url: 'https://hooks.slack.com/x' })).send('x'),
    ).resolves.toBeUndefined();
  });

  it('logOnlyNotifier resolves and logs', async () => {
    const logs: string[] = [];
    await logOnlyNotifier((m) => logs.push(m)).send('note');
    expect(logs.join('\n')).toContain('note');
  });
});
