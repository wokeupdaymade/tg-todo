// UI mode: HTML widgets when Telegram allows them, otherwise the spec's fallback
// (plain messages with inline keyboards). Since 13 Nov 2026 Telegram refuses
// sendWidget from ordinary bots (INPUT_MEDIA_WIDGET_NOT_ALLOWED), so the bot
// detects that, switches to the fallback, and re-checks every 12 h.
import { log } from '../log.ts';
import { MONTHS, WEEKDAYS, pad2, weekday, ymd } from '../time.ts';
import { TelegramError, type InlineButton, type InlineKeyboard } from '../telegram/api.ts';
import type { PreviewData } from './preview.ts';
import { type Ctx, HOUR, kvGet, kvSet } from './context.ts';

export type UiKind = 'widget' | 'text';
export type WidgetSetting = 'auto' | 'on' | 'off';
export const PROBE_AFTER = 12 * HOUR;

export class UiMode {
  private ctx: Ctx;
  private setting: WidgetSetting;

  constructor(ctx: Ctx, setting: WidgetSetting = 'auto') {
    this.ctx = ctx;
    this.setting = setting;
    // Re-check on every start: one refused send is cheap.
    if (setting === 'auto' && kvGet(ctx, 'widgets_mode') === 'blocked') kvSet(ctx, 'widgets_blocked_at', '0');
  }

  private state(): 'ok' | 'blocked' | 'unknown' {
    return (kvGet(this.ctx, 'widgets_mode') as 'ok' | 'blocked' | null) ?? 'unknown';
  }

  /** UI for a brand-new message (creation flow, reminder): may probe widgets again after 12 h. */
  forNewMessage(): UiKind {
    if (this.setting !== 'auto') return this.setting === 'on' ? 'widget' : 'text';
    if (this.state() !== 'blocked') return 'widget';
    const since = Number(kvGet(this.ctx, 'widgets_blocked_at') || 0);
    return this.ctx.now() - since >= PROBE_AFTER ? 'widget' : 'text';
  }

  /** UI for the long-lived preview: switches back to widgets only once a probe succeeded. */
  forPreview(): UiKind {
    if (this.setting !== 'auto') return this.setting === 'on' ? 'widget' : 'text';
    return this.state() === 'blocked' ? 'text' : 'widget';
  }

  /** True if the error means "widgets not allowed" (and records it). */
  blocked(e: unknown): boolean {
    if (this.setting !== 'auto' || !(e instanceof TelegramError) || !e.widgetsBlocked) return false;
    if (this.state() !== 'blocked') log.warn('Telegram refuses widgets for this bot: switching to the inline-keyboard fallback');
    kvSet(this.ctx, 'widgets_mode', 'blocked');
    kvSet(this.ctx, 'widgets_blocked_at', String(this.ctx.now()));
    return true;
  }

  succeeded() {
    if (this.setting !== 'auto' || this.state() === 'ok') return;
    if (this.state() === 'blocked') log.info('widgets are allowed again: switching back from the fallback');
    kvSet(this.ctx, 'widgets_mode', 'ok');
  }
}

// Rendering helpers -------------------------------------------------------------------

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cb = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const NOOP = 'nn.1';
const BLANK = '\u2800'; // Telegram rejects whitespace-only button text
function clipChars(s: string, n: number) { const c = Array.from(s); return c.length <= n ? s : c.slice(0, n - 1).join('') + '…'; }

/** Preview as a text message with ✓ buttons and an "Open App" web-app button. */
export function renderPreviewText(d: PreviewData, publicUrl: string): { text: string; markup: InlineKeyboard } {
  const line = (r: PreviewData['T'][number]) => {
    const [, title, label, f] = r;
    const t = esc(clipChars(title, 60));
    const meta = label ? ` — ${f & 2 ? `❗${esc(label)}` : esc(label)}` : '';
    return f & 1 ? `☑️ <s>${t}</s>` : `▫️ ${t}${meta}`;
  };
  const parts: string[] = [];
  if (!d.T.length && !d.O.length && !d.n && !d.m && !d.k) {
    parts.push('📋 <b>Nothing planned.</b>', 'Send me a message to add a task.');
  } else {
    parts.push(`📋 <b>Today</b> · ${esc(d.d)}`);
    parts.push(d.T.length ? d.T.map(line).join('\n') : '<i>Nothing left for today</i>');
    if (d.m) parts.push(`<i>+${d.m} more</i>`);
    if (d.O.length || d.k) {
      parts.push('', '<b>Other days</b>', d.O.map(line).join('\n'));
      if (d.k) parts.push(`<i>+${d.k} more</i>`);
    }
    if (d.n) parts.push('', `❗ <b>${d.n} overdue</b> — open the app to see them`);
  }
  const rows: InlineButton[][] = [...d.T, ...d.O].map(([id, title, , f]) =>
    [f & 1 ? cb(`↩️ Undo: ${clipChars(title, 28)}`, `pu.${id}`) : cb(`✓ ${clipChars(title, 32)}`, `pc.${id}`)]);
  rows.push([{ text: '📱 Open App', web_app: { url: `${publicUrl}/` } }]);
  return { text: parts.join('\n'), markup: { inline_keyboard: rows } };
}

export type FlowView = { kind: 'main' } | { kind: 'cal'; month: string } | { kind: 'hours' } | { kind: 'minutes'; hour: number };
export type FlowLike = { id: number; title: string; status: string; step: 'date' | 'time'; date: string | null; revision: number };

/** Creation flow as a text message with an inline keyboard. `today` comes from the server. */
export function renderFlowText(f: FlowLike, view: FlowView, today: string, dateLabel: string): { text: string; markup: InlineKeyboard } {
  const head = `📝 <b>${esc(f.title)}</b>`;
  const k = (op: string, arg = '') => `${op}.${f.id}.${f.revision}${arg ? '.' + arg : ''}`;
  const backCancel = [cb('‹ Back', k('fb')), cb('Cancel', k('fx'))];
  if (f.status === 'saved') return { text: `✅ Saved: <b>${esc(f.title)}</b>`, markup: { inline_keyboard: [] } };
  if (f.status === 'cancelled') return { text: `Cancelled: ${esc(f.title)}`, markup: { inline_keyboard: [] } };

  if (f.step === 'date') {
    if (view.kind === 'cal') return calendar(f, head, view.month, today, k);
    return {
      text: `${head}\nWhen? Pick a day — or type a date, e.g. <code>11.12</code> or <code>Dec 11</code>.`,
      markup: { inline_keyboard: [
        [cb('Today', k('fd', 't')), cb('Tomorrow', k('fd', 'm'))],
        [cb('Other Date…', k('fc', today.slice(0, 7).replace('-', '')))],
        [cb('Cancel', k('fx'))],
      ] },
    };
  }
  const when = `📅 ${esc(dateLabel)}`;
  if (view.kind === 'hours') {
    const rows: InlineButton[][] = [];
    for (let r = 0; r < 6; r++) rows.push([0, 1, 2, 3].map((c) => { const h = r * 4 + c; return cb(pad2(h), k('fm', pad2(h))); }));
    rows.push([cb('‹ Back', k('fv'))]);
    return { text: `${head}\n${when} — pick the hour:`, markup: { inline_keyboard: rows } };
  }
  if (view.kind === 'minutes') {
    const h = pad2(view.hour), rows: InlineButton[][] = [];
    for (let r = 0; r < 3; r++) rows.push([0, 1, 2, 3].map((c) => { const m = pad2((r * 4 + c) * 5); return cb(`${h}:${m}`, k('ft', h + m)); }));
    rows.push([cb('‹ Back', k('fh'))]);
    return { text: `${head}\n${when} — ${h}:__ pick the minutes:`, markup: { inline_keyboard: rows } };
  }
  return {
    text: `${head}\n${when} — what time? Pick one — or type it, e.g. <code>14:30</code>.`,
    markup: { inline_keyboard: [[cb('No Specific Time', k('ft', 'n'))], [cb('Select Time…', k('fh'))], backCancel] },
  };
}

function calendar(f: FlowLike, head: string, month: string, today: string, k: (op: string, arg?: string) => string) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(4, 6));
  const first = ymd(y, m, 1);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = m === 1 ? `${y - 1}12` : `${y}${pad2(m - 1)}`;
  const next = m === 12 ? `${y + 1}01` : `${y}${pad2(m + 1)}`;
  const canPrev = month > today.slice(0, 7).replace('-', '');
  const rows: InlineButton[][] = [[
    canPrev ? cb('‹', k('fc', prev)) : cb(BLANK, NOOP),
    cb(`${MONTHS[m - 1]} ${y}`, NOOP),
    cb('›', k('fc', next)),
  ], WEEKDAYS.map((w) => cb(w.slice(0, 2), NOOP))];
  let row: InlineButton[] = [];
  for (let i = 0; i < weekday(first); i++) row.push(cb(BLANK, NOOP));
  for (let d = 1; d <= days; d++) {
    const date = ymd(y, m, d);
    const label = date === f.date ? `✓${d}` : date === today ? `•${d}` : String(d);
    row.push(date < today ? cb('·', NOOP) : cb(label, k('fd', date.replace(/-/g, ''))));
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(cb(BLANK, NOOP)); rows.push(row); }
  rows.push([cb('‹ Back', k('fv')), cb('Cancel', k('fx'))]);
  return { text: `${head}\nPick a day:`, markup: { inline_keyboard: rows } };
}

/** Reminder as a text message. */
export function renderReminderText(taskId: number, revision: number, title: string, time: string, dateLabel: string): { text: string; markup: InlineKeyboard } {
  const k = (op: string) => `${op}.${taskId}.${revision}`;
  return {
    text: `⏰ <b>${esc(time)}</b>${dateLabel ? ` <i>${esc(dateLabel)}</i>` : ''}\n${esc(title)}`,
    markup: { inline_keyboard: [[cb('✓ Done', k('rd'))], [cb('Snooze 15 min', k('rs')), cb('Dismiss', k('rx'))]] },
  };
}

