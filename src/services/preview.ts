// The persistent in-chat preview widget (spec §5): one per user, updated by
// editing its chat state, rolled over before the 48 h deletion limit.
import { tx } from '../db.ts';
import { log } from '../log.ts';
import { type Task, compareTasks } from '../tasks.ts';
import { localNow, relativeDateLabel, shortDateLabel, timeToMinutes } from '../time.ts';
import { TelegramError } from '../telegram/api.ts';
import { bytes, widget } from '../widgets/index.ts';
import { type Ctx, HOUR, safeDelete } from './context.ts';
import type { TaskService } from './tasks.ts';
import { renderPreviewText, type UiMode } from './ui.ts';

export const UNDO_WINDOW = 5000;
export const ROLL_AFTER = 46.5 * HOUR;      // resend before the 48 h deletion limit
const MAX_DATA = 1000;                      // stay under the 1024-byte chat state limit
const PER_SECTION = 3, SINGLE_SECTION = 6;
export const TEXT_HASH = 'text-v1';          // previews.html_hash for the inline-keyboard fallback

type PreviewRow = { user_id: number; message_id: number; sent_at: number; html_hash: string; revision: number; last_data: string | null };

// Row: [id, title, label, flags]; flags: 1 = completed (undo pending), 2 = late (time passed)
export type PreviewRowData = [number, string, string, number];
export type PreviewData = {
  v: 1; r: number; b: string; d: string;
  T: PreviewRowData[]; O: PreviewRowData[];
  m: number; k: number;          // hidden counts ("+N more") for Today / Other days
  n: number;                     // overdue (past dates) count
  x?: 1;                         // superseded: this copy is stale
};

/** Pure: pick and shape the preview's content. */
export function buildPreviewData(active: Task[], recentlyDone: Task[], today: string, nowMin: number, botUsername: string, revision: number): PreviewData {
  const all = [...active, ...recentlyDone].sort(compareTasks);
  const todays = all.filter((t) => t.date === today);
  const others = all.filter((t) => t.date > today);
  const overdue = active.filter((t) => t.date < today).length;

  // Today: which rows matter most right now — late timed ones, then the next upcoming, then date-only.
  const rank = (t: Task) => {
    if (t.time === null) return 2_000 + t.id / 1e9;
    const m = timeToMinutes(t.time);
    return m < nowMin ? m / 10_000 : 1_000 + m;
  };
  let capT = PER_SECTION, capO = PER_SECTION;
  if (!others.length) capT = SINGLE_SECTION;
  if (!todays.length) capO = SINGLE_SECTION;
  const pickT = [...todays].sort((a, b) => rank(a) - rank(b)).slice(0, capT).sort(compareTasks);
  const pickO = others.slice(0, capO);

  const flags = (t: Task) => (t.completed_at ? 1 : 0) | (t.time && t.date === today && timeToMinutes(t.time) < nowMin ? 2 : 0);
  const data: PreviewData = {
    v: 1, r: revision, b: botUsername, d: shortDateLabel(today),
    T: pickT.map((t) => [t.id, t.title, t.time ?? '', flags(t)]),
    O: pickO.map((t) => [t.id, t.title, relativeDateLabel(t.date, today) + (t.time ? ` · ${t.time}` : ''), flags(t)]),
    m: todays.length - pickT.length, k: others.length - pickO.length, n: overdue,
  };
  return fitPreview(data);
}

/** Degrade gracefully to fit the chat-state limit: shorter titles, then fewer rows. Never fail. */
export function fitPreview(data: PreviewData): PreviewData {
  const full = { T: data.T, O: data.O };
  for (const max of [48, 32, 22, 14]) {
    const cut = (rows: PreviewRowData[]) => rows.map(([i, t, l, f]) => [i, trunc(t, max), l, f] as PreviewRowData);
    const d = { ...data, T: cut(full.T), O: cut(full.O) };
    if (bytes(JSON.stringify(d)) <= MAX_DATA) return d;
  }
  const d = { ...data, T: full.T.map(([i, t, l, f]) => [i, trunc(t, 14), l, f] as PreviewRowData), O: full.O.map(([i, t, l, f]) => [i, trunc(t, 14), l, f] as PreviewRowData) };
  while (bytes(JSON.stringify(d)) > MAX_DATA && (d.T.length || d.O.length)) {
    if (d.O.length >= d.T.length) { d.O = d.O.slice(0, -1); d.k++; } else { d.T = d.T.slice(0, -1); d.m++; }
  }
  return d;
}

function trunc(s: string, max: number): string {
  const c = Array.from(s);
  return c.length <= max ? s : c.slice(0, max - 1).join('') + '…';
}

export class PreviewService {
  private ctx: Ctx;
  private tasks: TaskService;
  private timers = new Map<number, NodeJS.Timeout>();
  private running = new Map<number, Promise<void>>();
  private dirty = new Set<number>();
  private ui: UiMode;

  constructor(ctx: Ctx, tasks: TaskService, ui: UiMode) {
    this.ctx = ctx;
    this.tasks = tasks;
    this.ui = ui;
    tasks.onChange(({ userId, kind }) => {
      this.schedule(userId);
      // Hide a completed row once its undo window ends.
      if (kind === 'complete') this.schedule(userId, UNDO_WINDOW + 300);
    });
  }

  row(userId: number): PreviewRow | null {
    return (this.ctx.db.prepare('SELECT * FROM previews WHERE user_id = ?').get(userId) as PreviewRow | undefined) ?? null;
  }

  data(userId: number, revision: number): PreviewData {
    const now = this.ctx.now();
    const ln = localNow(now, this.tasks.tz(userId));
    return buildPreviewData(this.tasks.listActive(userId), this.tasks.listRecentlyCompleted(userId, now - UNDO_WINDOW),
      ln.date, ln.minutes, this.ctx.botUsername, revision);
  }

  /** Coalesce rapid successive updates into one edit. */
  schedule(userId: number, delay = 400) {
    if (delay > 400) {
      setTimeout(() => this.schedule(userId), delay - 400).unref?.();
      return;
    }
    const existing = this.timers.get(userId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(userId);
      void this.refresh(userId);
    }, delay);
    t.unref?.();
    this.timers.set(userId, t);
  }

  /** Wait for pending coalesced updates (tests, shutdown). */
  async flush() {
    for (const [userId, t] of this.timers) { clearTimeout(t); this.timers.delete(userId); await this.refresh(userId); }
    await Promise.all(this.running.values());
  }

  /** Bring the preview up to date (serialized per user). */
  refresh(userId: number): Promise<void> {
    if (this.running.has(userId)) { this.dirty.add(userId); return this.running.get(userId)!; }
    const p = (async () => {
      try {
        do {
          this.dirty.delete(userId);
          await this.refreshOnce(userId);
        } while (this.dirty.has(userId));
      } catch (e) {
        log.error(`preview refresh for ${userId} failed`, e);
      } finally {
        this.running.delete(userId);
      }
    })();
    this.running.set(userId, p);
    return p;
  }

  private async refreshOnce(userId: number) {
    const row = this.row(userId);
    if (!row) return this.resendNow(userId);
    if (row.html_hash !== this.expectedHash() || this.ctx.now() - row.sent_at >= ROLL_AFTER) return this.resendNow(userId);

    const isText = row.html_hash === TEXT_HASH;
    const probe = this.content(userId, row.revision, isText);
    if (row.last_data && sameContent(row.last_data, probe)) return;
    const revision = row.revision + 1;
    const next = { ...probe, r: revision };
    const json = JSON.stringify(next);
    try {
      if (isText) {
        const { text, markup } = renderPreviewText(next, this.ctx.cfg.publicUrl);
        await this.ctx.tg.editText(userId, row.message_id, text, markup);
      } else {
        await this.ctx.tg.editWidgetData(userId, row.message_id, json);
      }
    } catch (e) {
      if (e instanceof TelegramError && e.notModified) { /* already current */ }
      else if (e instanceof TelegramError && e.code === 400) {
        log.warn(`preview edit failed (${e.description}); resending`);
        return this.resendNow(userId);
      } else throw e;
    }
    this.ctx.db.prepare('UPDATE previews SET revision = ?, last_data = ? WHERE user_id = ?').run(revision, json, userId);
  }

  /** Send a fresh preview, then remove the old one (or mark it superseded). */
  resend(userId: number): Promise<void> {
    if (this.running.has(userId)) {
      return this.running.get(userId)!.then(() => this.resend(userId));
    }
    const p = this.resendNow(userId).catch((e) => log.error(`preview resend for ${userId} failed`, e)).finally(() => this.running.delete(userId));
    this.running.set(userId, p);
    return p;
  }

  private expectedHash(): string {
    return this.ui.forPreview() === 'widget' ? widget('preview').hash : TEXT_HASH;
  }

  /** Preview state; the text fallback also tracks the Mini App URL (its button changes with it). */
  private content(userId: number, revision: number, isText: boolean): PreviewData & { u?: string } {
    const d = this.data(userId, revision);
    return isText ? { ...d, u: this.ctx.cfg.publicUrl } : d;
  }

  private async resendNow(userId: number) {
    const old = this.row(userId);
    const revision = (old?.revision ?? 0) + 1;
    let msg: { message_id: number } | null = null;
    let hash = TEXT_HASH;
    let json = '';
    if (this.ui.forPreview() === 'widget') {
      const w = widget('preview');
      json = JSON.stringify(this.content(userId, revision, false));
      try {
        msg = await this.ctx.tg.sendWidget({
          chat_id: userId, html: w.html, chat_data: json, allow_queries: true, disable_notification: true,
          caption: '📋 Your tasks — open the app to see everything',
        });
        hash = w.hash;
        this.ui.succeeded();
      } catch (e) {
        if (!this.ui.blocked(e)) throw e;
      }
    }
    if (!msg) {
      const content = this.content(userId, revision, true);
      json = JSON.stringify(content);
      const { text, markup } = renderPreviewText(content, this.ctx.cfg.publicUrl);
      msg = await this.ctx.tg.sendText(userId, text, markup, { disable_notification: true });
    }
    const now = this.ctx.now();
    tx(this.ctx.db, () => {
      this.ctx.db.prepare(`INSERT INTO previews (user_id, message_id, sent_at, html_hash, revision, last_data) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET message_id = excluded.message_id, sent_at = excluded.sent_at, html_hash = excluded.html_hash,
          revision = excluded.revision, last_data = excluded.last_data`).run(userId, msg.message_id, now, hash, revision, json);
    });
    log.info(`preview sent to ${userId} (message ${msg.message_id})`);
    if (this.ctx.cfg.pinPreview) {
      try { await this.ctx.tg.pinChatMessage(userId, msg.message_id); } catch (e) { log.warn('pin failed', e instanceof Error ? e.message : e); }
    }
    if (old && old.message_id !== msg.message_id) {
      const gone = await safeDelete(this.ctx, userId, old.message_id);
      if (!gone) {
        // Past the deletion window (e.g. after downtime): flip the stranded copy to its "superseded" view.
        try {
          if (old.html_hash === TEXT_HASH) {
            await this.ctx.tg.editText(userId, old.message_id, '📋 <i>This preview is out of date — the current one is further down.</i>');
          } else {
            const stale = JSON.parse(old.last_data || '{}');
            await this.ctx.tg.editWidgetData(userId, old.message_id, JSON.stringify({ ...stale, r: (old.revision ?? 0) + 1, x: 1 }));
          }
        } catch (e) { log.warn('could not mark old preview as superseded', e instanceof Error ? e.message : e); }
      }
    }
  }

  /** Scheduler hook: rollover before 48 h, layout upgrades, and time-driven changes (late times, midnight). */
  async tick() {
    for (const userId of this.tasks.userIds()) {
      const row = this.row(userId);
      if (!row) continue;
      await this.refresh(userId);
    }
  }
}

function sameContent(lastJson: string, next: PreviewData & { u?: string }): boolean {
  try {
    const a = JSON.parse(lastJson);
    delete a.r;
    const b: Partial<PreviewData & { u?: string }> = { ...next };
    delete b.r;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}
