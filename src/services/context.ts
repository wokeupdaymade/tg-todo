// Shared application context and small cross-cutting helpers.
import type { Config } from '../config.ts';
import type { DB } from '../db.ts';
import { Tg, TelegramError } from '../telegram/api.ts';
import { log } from '../log.ts';

export type Ctx = {
  cfg: Pick<Config, 'defaultTz' | 'pinPreview' | 'publicUrl'>;
  db: DB;
  tg: Tg;
  now: () => number;
  botUsername: string;
};

export const HOUR = 3600_000;
export const MIN = 60_000;
/** Telegram lets bots delete messages for 48 h; stay safely inside it. */
export const DELETE_WINDOW = 46 * HOUR;

/** Delete a message; failures are logged, never fatal. Returns true if it is gone. */
export async function safeDelete(ctx: Ctx, chatId: number, messageId: number | null | undefined): Promise<boolean> {
  if (!messageId) return true;
  try {
    await ctx.tg.deleteMessage(chatId, messageId);
    return true;
  } catch (e) {
    if (e instanceof TelegramError && /message to delete not found/i.test(e.description)) return true;
    log.warn(`delete ${chatId}/${messageId} failed`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Queue a message for deletion at `deleteAt` (retried by the scheduler). */
export function scheduleDeletion(ctx: Ctx, chatId: number, messageId: number, deleteAt: number, sentAt = ctx.now()) {
  ctx.db.prepare(`INSERT OR REPLACE INTO pending_deletions (chat_id, message_id, delete_at, sent_at) VALUES (?, ?, ?, ?)`)
    .run(chatId, messageId, deleteAt, sentAt);
}

export async function runPendingDeletions(ctx: Ctx) {
  const now = ctx.now();
  const rows = ctx.db.prepare(`SELECT chat_id, message_id, sent_at FROM pending_deletions WHERE delete_at <= ? LIMIT 50`).all(now) as
    { chat_id: number; message_id: number; sent_at: number }[];
  for (const r of rows) {
    const ok = await safeDelete(ctx, r.chat_id, r.message_id);
    if (ok || now - r.sent_at > 47.5 * HOUR) {
      ctx.db.prepare(`DELETE FROM pending_deletions WHERE chat_id = ? AND message_id = ?`).run(r.chat_id, r.message_id);
    } else {
      ctx.db.prepare(`UPDATE pending_deletions SET delete_at = ? WHERE chat_id = ? AND message_id = ?`).run(now + 5 * MIN, r.chat_id, r.message_id);
    }
  }
}

/** Send a short transient notice that deletes itself. */
export async function notice(ctx: Ctx, chatId: number, text: string, ttlMs = 20_000, extra: Record<string, unknown> = {}) {
  try {
    const m = await ctx.tg.sendMessage(chatId, text, { disable_notification: true, ...extra });
    scheduleDeletion(ctx, chatId, m.message_id, ctx.now() + ttlMs);
    return m;
  } catch (e) {
    log.warn('notice failed', e instanceof Error ? e.message : e);
    return null;
  }
}

export function kvGet(ctx: Ctx, key: string): string | null {
  const r = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function kvSet(ctx: Ctx, key: string, value: string) {
  ctx.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}
