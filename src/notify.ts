import type { Config, NotificationsConfig } from './types.js';

/** A tap-to-act button on an escalation. `data` is echoed back by Telegram as a
 * callback_query the bot handles (see bot.ts). Only Telegram renders these;
 * other channels ignore them and send plain text. */
export interface NotifyButton {
  label: string;
  data: string;
}

/** Pushes an escalation somewhere a human will actually see it. Implementations
 * are best-effort: `send` NEVER throws and never blocks a tick for long, so a
 * down webhook can't stall or crash the scheduler. */
export interface Notifier {
  send(text: string, buttons?: NotifyButton[]): Promise<void>;
}

/** A notifier that only logs (used when no notifications channel is configured),
 * so escalations still leave a trace in the loop output. */
export function logOnlyNotifier(log: (msg: string) => void = () => {}): Notifier {
  return {
    async send(text: string): Promise<void> {
      log(`escalation (no notifications channel configured): ${text}`);
    },
  };
}

/** Build the notifier for a config: an HTTP pusher when `notifications` is set,
 * otherwise log-only. Network failures are swallowed (logged) — an escalation
 * that can't be delivered must not take the scheduler down with it. */
export function makeNotifier(config: Config, log: (msg: string) => void = () => {}): Notifier {
  const cfg = config.notifications;
  if (!cfg) return logOnlyNotifier(log);
  return {
    async send(text: string, buttons?: NotifyButton[]): Promise<void> {
      try {
        await deliver(cfg, text, buttons);
      } catch (e) {
        log(`notification delivery failed (${(e as Error).message}); escalation: ${text}`);
      }
    },
  };
}

async function deliver(cfg: NotificationsConfig, text: string, buttons?: NotifyButton[]): Promise<void> {
  const signal = AbortSignal.timeout(15_000);
  if (cfg.type === 'telegram') {
    const { botToken, chatId } = cfg.telegram!;
    const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (buttons && buttons.length > 0) {
      // one button per row keeps long labels readable on mobile
      body.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.label, callback_data: b.data }]) };
    }
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
    return;
  }
  // slack uses {text}, discord uses {content}; a generic webhook gets both so it
  // works regardless of which key the receiver reads. Buttons are Telegram-only.
  const body =
    cfg.type === 'slack' ? { text } : cfg.type === 'discord' ? { content: text } : { text, content: text };
  const res = await fetch(cfg.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${cfg.type} HTTP ${res.status}`);
}
