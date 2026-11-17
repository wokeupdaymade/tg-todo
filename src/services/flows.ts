// Chat-based task creation (spec §6): a server-side state machine per flow.
// Decision: one open flow at a time. While a flow is open, every typed text is
// date/time input for it; a new title can only start once it is saved or cancelled.
import { log } from '../log.ts';
import { parseDate, parseTime } from '../parse.ts';
import { normalizeTitle } from '../tasks.ts';
import { addDays, localNow, shortDateLabel } from '../time.ts';
import type { Message, ReplyMarkup } from '../telegram/api.ts';
import { TelegramError } from '../telegram/api.ts';
import { widget } from '../widgets/index.ts';
import { type Ctx, HOUR, safeDelete } from './context.ts';
import type { TaskService } from './tasks.ts';
import { type FlowView, renderFlowText, type UiKind, type UiMode } from './ui.ts';

export const FLOW_TTL = 6 * HOUR;

export type Flow = {
  id: number; user_id: number; status: 'open' | 'saved' | 'cancelled'; step: 'date' | 'time';
  title: string; date: string | null; revision: number;
  source_message_id: number | null; widget_message_id: number | null; prompt_message_id: number | null; hint_message_id: number | null;
  calendar_hint: number; created_at: number; updated_at: number;
  ui: UiKind;   // 'widget' or 'text' (inline-keyboard fallback)
};

// Reply-keyboard shortcut labels (spec §6.4).
export const KB = {
  today: 'Today', tomorrow: 'Tomorrow', other: 'Other Date', cancel: 'Cancel',
  noTime: 'No Specific Time', back: 'Back',
};
export const COMMON_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];
const ALL_LABELS = new Set([...Object.values(KB), ...COMMON_TIMES]);

const DATE_KB: ReplyMarkup = {
  keyboard: [[{ text: KB.today }, { text: KB.tomorrow }, { text: KB.other }], [{ text: KB.cancel }]],
  resize_keyboard: true, is_persistent: false, input_field_placeholder: 'Or type a date, e.g. 11.12 or Dec 11',
};
const TIME_KB: ReplyMarkup = {
  keyboard: [[{ text: KB.noTime }], COMMON_TIMES.map((t) => ({ text: t })), [{ text: KB.back }, { text: KB.cancel }]],
  resize_keyboard: true, is_persistent: false, input_field_placeholder: 'Or type a time, e.g. 14:30',
};

export type FlowAnswer = { ok: 1 } | { e: string };

export class FlowService {
  private ctx: Ctx;
  private tasks: TaskService;
  private ui: UiMode;

  constructor(ctx: Ctx, tasks: TaskService, ui: UiMode) {
    this.ctx = ctx;
    this.tasks = tasks;
    this.ui = ui;
  }

  get(id: number): Flow | null {
    return (this.ctx.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as Flow | undefined) ?? null;
  }

  openFlow(userId: number): Flow | null {
    return (this.ctx.db.prepare(`SELECT * FROM flows WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(userId) as Flow | undefined) ?? null;
  }

  private save(f: Flow) {
    f.updated_at = this.ctx.now();
    this.ctx.db.prepare(`UPDATE flows SET status = ?, step = ?, date = ?, revision = ?, widget_message_id = ?, prompt_message_id = ?,
      hint_message_id = ?, calendar_hint = ?, updated_at = ? WHERE id = ?`)
      .run(f.status, f.step, f.date, f.revision, f.widget_message_id, f.prompt_message_id, f.hint_message_id, f.calendar_hint, f.updated_at, f.id);
  }

  private today(userId: number) { return localNow(this.ctx.now(), this.tasks.tz(userId)).date; }

  private widgetState(f: Flow) {
    const s = f.status === 'saved' ? 'S' : f.status === 'cancelled' ? 'X' : f.step === 'date' ? 'd' : 't';
    return JSON.stringify({
      v: 1, r: f.revision, i: f.id, t: Array.from(f.title).slice(0, 120).join(''), s,
      d: f.date ?? '', l: f.date ? shortDateLabel(f.date, this.today(f.user_id)) : '', y: this.today(f.user_id), c: f.calendar_hint,
    });
  }

  private textView(f: Flow, view?: FlowView) {
    const today = this.today(f.user_id);
    const v: FlowView = view ?? (f.calendar_hint && f.step === 'date' ? { kind: 'cal', month: today.slice(0, 7).replace('-', '') } : { kind: 'main' });
    return renderFlowText(f, v, today, f.date ? shortDateLabel(f.date, today) : '');
  }

  private async pushState(f: Flow, view?: FlowView) {
    if (!f.widget_message_id) return;
    try {
      if (f.ui === 'text') {
        const { text, markup } = this.textView(f, view);
        await this.ctx.tg.editText(f.user_id, f.widget_message_id, text, markup);
      } else {
        await this.ctx.tg.editWidgetData(f.user_id, f.widget_message_id, this.widgetState(f));
      }
    } catch (e) {
      if (!(e instanceof TelegramError && e.notModified)) log.warn(`flow ${f.id} widget update failed`, e instanceof Error ? e.message : e);
    }
  }

  // Entry points ---------------------------------------------------------------

  /** Ordinary text from the user (not a command). */
  async onText(msg: Message) {
    const userId = msg.chat.id;
    const text = msg.text ?? '';
    const flow = this.openFlow(userId);
    if (flow) return this.onInput(flow, msg);
    if (ALL_LABELS.has(text.trim())) {
      // A stray shortcut press with no flow: never a task. Clean up and drop the keyboard.
      await safeDelete(this.ctx, userId, msg.message_id);
      await this.removeKeyboard(userId);
      return;
    }
    return this.start(msg);
  }

  async start(msg: Message) {
    const userId = msg.chat.id;
    const title = normalizeTitle(msg.text ?? '');
    if (!title) { await safeDelete(this.ctx, userId, msg.message_id); return; }
    const now = this.ctx.now();
    const ui = this.ui.forNewMessage();
    const r = this.ctx.db.prepare(`INSERT INTO flows (user_id, status, step, title, revision, source_message_id, created_at, updated_at, ui)
      VALUES (?, 'open', 'date', ?, 1, ?, ?, ?, ?)`).run(userId, title, msg.message_id, now, now, ui);
    const f = this.get(Number(r.lastInsertRowid))!;
    try {
      if (f.ui === 'widget') {
        try {
          const sent = await this.ctx.tg.sendWidget({
            chat_id: userId, html: widget('creation').html, chat_data: this.widgetState(f), allow_queries: true,
            caption: `New task: ${title}`.slice(0, 1024), reply_markup: DATE_KB,
          });
          f.widget_message_id = sent.message_id;
          this.ui.succeeded();
        } catch (e) {
          if (!this.ui.blocked(e)) throw e;
          f.ui = 'text';
          this.ctx.db.prepare(`UPDATE flows SET ui = 'text' WHERE id = ?`).run(f.id);
        }
      }
      if (f.ui === 'text') {
        // Fallback: one message with an inline keyboard; no reply keyboard (it would only duplicate the buttons).
        const { text, markup } = this.textView(f);
        const sent = await this.ctx.tg.sendText(userId, text, markup);
        f.widget_message_id = sent.message_id;
      }
      this.save(f);
    } catch (e) {
      log.error('could not start creation flow', e);
      f.status = 'cancelled';
      this.save(f);
      throw e;
    }
  }

  /** Typed text or a shortcut press while a flow is open. */
  private async onInput(f: Flow, msg: Message) {
    const text = (msg.text ?? '').trim();
    const userId = f.user_id;
    await safeDelete(this.ctx, userId, msg.message_id);

    if (text === KB.cancel) return this.cancel(f);
    if (f.step === 'date') {
      if (text === KB.today) return this.chooseDate(f, this.today(userId));
      if (text === KB.tomorrow) return this.chooseDate(f, addDays(this.today(userId), 1));
      if (text === KB.other) {
        f.calendar_hint = 1; f.revision++; this.save(f);
        await this.pushState(f);
        return this.hint(f, 'Pick a day in the calendar above, or type a date like 11.12 or Dec 11.');
      }
      const d = parseDate(text, this.today(userId));
      if (!d) return this.hint(f, `Couldn't read “${clip(text)}” as a date. Try 11.12, 11 Dec or December 11 — or tap a button.`);
      return this.chooseDate(f, d);
    }
    // step: time
    if (text === KB.back) return this.back(f);
    if (text === KB.noTime) return this.finish(f, null);
    const t = parseTime(text);
    if (!t) return this.hint(f, `Couldn't read “${clip(text)}” as a time. Try 14:30, 9.45 or 9:45 PM — or tap a button.`);
    return this.finish(f, t);
  }

  /** A tap in the creation widget. Data: "<op>.<flowId>.<rev>[.<arg>]". */
  async onWidgetQuery(userId: number, messageId: number | undefined, op: string, flowId: number, rev: number, arg: string): Promise<FlowAnswer> {
    const f = this.get(flowId);
    if (!f || f.user_id !== userId || !messageId || f.widget_message_id !== messageId) return { e: 'Unknown task draft' };
    if (f.status !== 'open') return { e: 'This draft is closed' };
    if (f.revision !== rev) { await this.pushState(f); return { e: 'Updated — try again' }; }
    switch (op) {
      case 'fd': {
        if (f.step !== 'date') return { e: 'Wrong step' };
        const today = this.today(userId);
        let date: string | null = null;
        if (arg === 't') date = today;
        else if (arg === 'm') date = addDays(today, 1);
        else if (/^\d{8}$/.test(arg)) date = parseDate(`${arg.slice(0, 4)}-${arg.slice(4, 6)}-${arg.slice(6)}`, today);
        if (!date) return { e: 'Invalid date' };
        await this.chooseDate(f, date);
        return { ok: 1 };
      }
      case 'ft': {
        if (f.step !== 'time') return { e: 'Wrong step' };
        let time: string | null = null;
        if (arg !== 'n') {
          time = /^\d{4}$/.test(arg) ? parseTime(`${arg.slice(0, 2)}:${arg.slice(2)}`) : null;
          if (!time) return { e: 'Invalid time' };
        }
        await this.finish(f, time);
        return { ok: 1 };
      }
      case 'fb':
        if (f.step !== 'time') return { e: 'Wrong step' };
        await this.back(f);
        return { ok: 1 };
      case 'fx':
        await this.cancel(f);
        return { ok: 1 };
      // View-only navigation of the fallback keyboard (calendar, hour/minute grids): no state change.
      case 'fc': {
        if (f.step !== 'date' || !/^\d{6}$/.test(arg)) return { e: 'Wrong step' };
        const mo = Number(arg.slice(4));
        if (mo < 1 || mo > 12) return { e: 'Invalid month' };
        await this.pushState(f, { kind: 'cal', month: arg });
        return { ok: 1 };
      }
      case 'fh':
        if (f.step !== 'time') return { e: 'Wrong step' };
        await this.pushState(f, { kind: 'hours' });
        return { ok: 1 };
      case 'fm': {
        const h = Number(arg);
        if (f.step !== 'time' || !/^\d{2}$/.test(arg) || h > 23) return { e: 'Wrong step' };
        await this.pushState(f, { kind: 'minutes', hour: h });
        return { ok: 1 };
      }
      case 'fv':
        if (f.calendar_hint) { f.calendar_hint = 0; this.save(f); }
        await this.pushState(f, { kind: 'main' });
        return { ok: 1 };
    }
    return { e: 'Unknown action' };
  }

  // Transitions ----------------------------------------------------------------

  private async chooseDate(f: Flow, date: string) {
    f.date = date; f.step = 'time'; f.calendar_hint = 0; f.revision++;
    this.save(f);
    await this.pushState(f);
    await this.clearHint(f);
    await this.prompt(f, `${shortDateLabel(date, this.today(f.user_id))}. Pick a time, or type one (e.g. 14:30).`, TIME_KB);
  }

  private async back(f: Flow) {
    f.step = 'date'; f.calendar_hint = 0; f.revision++;
    this.save(f);
    await this.pushState(f);
    await this.clearHint(f);
    await this.prompt(f, 'Pick a date, or type one (e.g. 11.12).', DATE_KB);
  }

  private async finish(f: Flow, time: string | null) {
    if (!f.date) return this.back(f);
    await this.tasks.create(f.user_id, { title: f.title, date: f.date, time });
    f.status = 'saved'; f.revision++;
    this.save(f);
    await this.cleanup(f);
  }

  async cancel(f: Flow) {
    f.status = 'cancelled'; f.revision++;
    this.save(f);
    await this.cleanup(f);
  }

  /** Delete everything the flow put in the chat and drop the reply keyboard. */
  private async cleanup(f: Flow) {
    const userId = f.user_id;
    const ids = [f.source_message_id, f.widget_message_id, f.prompt_message_id, f.hint_message_id].filter((x): x is number => !!x);
    let allGone = true;
    if (ids.length) {
      try { await this.ctx.tg.deleteMessages(userId, ids); } catch {
        for (const id of ids) allGone = (await safeDelete(this.ctx, userId, id)) && allGone;
      }
    }
    if (!allGone) await this.pushState(f); // the widget shows "Saved" / "Cancelled" if it survived
    if (f.ui === 'widget') await this.removeKeyboard(userId);
  }

  private async prompt(f: Flow, text: string, kb: ReplyMarkup) {
    if (f.ui === 'text') return; // the fallback message itself carries the buttons and the hint
    const old = f.prompt_message_id;
    try {
      const m = await this.ctx.tg.sendMessage(f.user_id, text, { reply_markup: kb, disable_notification: true });
      f.prompt_message_id = m.message_id;
      this.save(f);
    } catch (e) { log.warn('prompt failed', e instanceof Error ? e.message : e); }
    if (old) await safeDelete(this.ctx, f.user_id, old);
  }

  private async hint(f: Flow, text: string) {
    const old = f.hint_message_id;
    try {
      const m = await this.ctx.tg.sendMessage(f.user_id, text, { disable_notification: true });
      f.hint_message_id = m.message_id;
      this.save(f);
    } catch (e) { log.warn('hint failed', e instanceof Error ? e.message : e); }
    if (old) await safeDelete(this.ctx, f.user_id, old);
  }

  private async clearHint(f: Flow) {
    if (!f.hint_message_id) return;
    const id = f.hint_message_id;
    f.hint_message_id = null;
    this.save(f);
    await safeDelete(this.ctx, f.user_id, id);
  }

  async removeKeyboard(userId: number) {
    try {
      const m = await this.ctx.tg.sendMessage(userId, '✓', { reply_markup: { remove_keyboard: true }, disable_notification: true });
      await safeDelete(this.ctx, userId, m.message_id);
    } catch (e) { log.warn('keyboard removal failed', e instanceof Error ? e.message : e); }
  }

  /** Scheduler hook: auto-cancel flows abandoned for 6 h. */
  async expire() {
    const old = this.ctx.db.prepare(`SELECT * FROM flows WHERE status = 'open' AND updated_at < ?`).all(this.ctx.now() - FLOW_TTL) as Flow[];
    for (const f of old) {
      log.info(`flow ${f.id} abandoned; cancelling`);
      await this.cancel(f);
    }
  }
}

const clip = (s: string) => (s.length > 40 ? s.slice(0, 39) + '…' : s);
