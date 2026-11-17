// Routes Telegram updates: whitelisting, commands, chat text, widget queries.
import { log } from '../log.ts';
import { isValidTimeZone, localNow } from '../time.ts';
import type { CallbackQuery, Message, Update, WidgetQuery } from '../telegram/api.ts';
import { type Ctx, notice, safeDelete } from '../services/context.ts';
import type { FlowService } from '../services/flows.ts';
import type { PreviewService } from '../services/preview.ts';
import type { ReminderService } from '../services/reminders.ts';
import { ConflictError, NotFoundError, type TaskService } from '../services/tasks.ts';

export type Services = { tasks: TaskService; preview: PreviewService; reminders: ReminderService; flows: FlowService };

export class Router {
  private ctx: Ctx;
  private s: Services;
  private allowed: Set<number>;

  constructor(ctx: Ctx, s: Services, allowed: Set<number>) {
    this.ctx = ctx;
    this.s = s;
    this.allowed = allowed;
  }

  async handle(u: Update) {
    if (u.widget_query) return this.onWidgetQuery(u.widget_query);
    if (u.callback_query) return this.onCallbackQuery(u.callback_query);
    if (u.shared_widget_query) return; // we never send shared widgets
    if (u.message) return this.onMessage(u.message);
  }

  private async onMessage(msg: Message) {
    // Private, single-user product: ignore everything from anyone else, anywhere else.
    if (msg.chat.type !== 'private' || !msg.from || !this.allowed.has(msg.from.id) || msg.chat.id !== msg.from.id) return;
    const userId = msg.from.id;
    const user = this.s.tasks.ensureUser(userId);
    if (user.created) log.info(`new user ${userId}`);

    const text = msg.text;
    if (text === undefined) {
      // Non-text messages (stickers, photos, service messages…) are deleted silently.
      await safeDelete(this.ctx, userId, msg.message_id);
      return;
    }
    if (user.created && !text.startsWith('/start')) await this.s.preview.resend(userId);
    if (text.startsWith('/')) return this.onCommand(msg, userId, text);
    await this.s.flows.onText(msg);
  }

  private async onCommand(msg: Message, userId: number, text: string) {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
    const arg = rest.join(' ');
    await safeDelete(this.ctx, userId, msg.message_id);
    switch (cmd) {
      case '/start':
        await this.s.preview.resend(userId);
        return;
      case '/cancel': {
        const f = this.s.flows.openFlow(userId);
        if (f) await this.s.flows.cancel(f);
        else await this.s.flows.removeKeyboard(userId);
        return;
      }
      case '/settings':
      case '/timezone':
      case '/tz': {
        if (!arg) {
          const tz = this.s.tasks.tz(userId);
          const ln = localNow(this.ctx.now(), tz);
          await notice(this.ctx, userId,
            `Time zone: ${tz} (now ${ln.time}, ${ln.date}).\nTo change it, send /settings followed by an IANA zone name, e.g. /settings Europe/Berlin`, 60_000);
          return;
        }
        const tz = normalizeTz(arg);
        if (!tz) { await notice(this.ctx, userId, `“${arg.slice(0, 40)}” is not a time zone I know. Example: /settings America/New_York`, 30_000); return; }
        await this.s.tasks.setTz(userId, tz);
        this.s.preview.schedule(userId);
        const ln = localNow(this.ctx.now(), tz);
        await notice(this.ctx, userId, `Time zone set to ${tz} (now ${ln.time}).`, 15_000);
        return;
      }
      default:
        return; // unknown commands are just deleted
    }
  }

  private async onWidgetQuery(q: WidgetQuery) {
    const answer = async (data: Answer) => {
      await this.ctx.tg.answerWidgetQuery(q.id, JSON.stringify(data)).catch((e) => log.warn('answerWidgetQuery failed', e instanceof Error ? e.message : e));
    };
    await this.onAction(q.from.id, q.chat?.id, q.message_id, q.data, answer);
  }

  /** Inline-keyboard fallback: button taps carry the same action strings as widget requests. */
  private async onCallbackQuery(q: CallbackQuery) {
    let answered = false;
    const answer = async (data: Answer) => {
      if (answered) return;
      answered = true;
      await this.ctx.tg.answerCallbackQuery(q.id, 'e' in data ? data.e : undefined)
        .catch((e) => log.warn('answerCallbackQuery failed', e instanceof Error ? e.message : e));
    };
    await this.onAction(q.from.id, q.message?.chat.id, q.message?.message_id, q.data ?? '', answer);
  }

  private async onAction(fromId: number, chatId: number | undefined, messageId: number | undefined, data: string, answer: (a: Answer) => Promise<void>) {
    if (!this.allowed.has(fromId) || chatId !== fromId) { await answer({ e: 'Not allowed' }); return; }
    const userId = fromId;
    this.s.tasks.ensureUser(userId);
    const q = { message_id: messageId };
    // `from` and message_id are trusted (set by Telegram); `data` is not: validate everything.
    const parts = data.split('.');
    const op = parts[0];
    const id = Number(parts[1]);
    if (!/^[a-z]{2}$/.test(op) || !Number.isSafeInteger(id) || id <= 0) { await answer({ e: 'Bad request' }); return; }
    try {
      switch (op) {
        // Preview widget: complete / undo
        case 'pc':
        case 'pu': {
          const p = this.s.preview.row(userId);
          if (!p || p.message_id !== q.message_id) { await answer({ e: 'Outdated preview' }); return; }
          const t = this.s.tasks.get(userId, id);
          if (!t || t.deleted_at) { await answer({ e: 'Task not found' }); this.s.preview.schedule(userId); return; }
          // Idempotent: a retried tap that already took effect is still a success.
          if (op === 'pc' && !t.completed_at) await this.s.tasks.complete(userId, id);
          else if (op === 'pu' && t.completed_at) await this.s.tasks.uncomplete(userId, id);
          await answer({ ok: 1 });
          return;
        }
        case 'nn': // inert fallback buttons (calendar headers, blanks)
          await answer({ ok: 1 });
          return;
        // Creation flow (fc/fh/fm/fv: fallback keyboard navigation)
        case 'fd': case 'ft': case 'fb': case 'fx': case 'fc': case 'fh': case 'fm': case 'fv': {
          const rev = Number(parts[2]);
          const res = await this.s.flows.onWidgetQuery(userId, q.message_id, op, id, rev, parts[3] ?? '');
          await answer(res);
          return;
        }
        // Reminder widget: done / snooze / dismiss
        case 'rd': case 'rs': case 'rx': {
          if (!this.s.reminders.ownsMessage(id, q.message_id)) { await answer({ e: 'Reminder is no longer active' }); return; }
          await answer({ ok: 1 }); // answer first: the message is deleted by the action
          if (op === 'rd') await this.s.reminders.done(userId, id);
          else if (op === 'rs') await this.s.reminders.snooze(userId, id);
          else await this.s.reminders.dismiss(userId, id);
          return;
        }
      }
      await answer({ e: 'Unknown action' });
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) {
        await answer({ e: e instanceof NotFoundError ? 'Task not found' : 'Already changed' });
        this.s.preview.schedule(userId);
        return;
      }
      log.error('action failed', e);
      await answer({ e: 'Something went wrong' });
    }
  }
}

type Answer = { ok: 1 } | { e: string };

/** Accepts IANA names case-insensitively ("europe/berlin") and UTC / UTC±H[:MM]. */
export function normalizeTz(input: string): string | null {
  const s = input.trim();
  if (/^(utc|gmt|z)$/i.test(s)) return 'UTC';
  const off = s.match(/^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (off) {
    const h = Number(off[2]), m = Number(off[3] || 0);
    if (m !== 0 || h > 14) return null; // Etc/GMT zones are whole hours only
    if (h === 0) return 'UTC';
    // POSIX sign convention: Etc/GMT-3 is UTC+3.
    return `Etc/GMT${off[1] === '+' ? '-' : '+'}${h}`;
  }
  if (isValidTimeZone(s)) {
    try { return new Intl.DateTimeFormat('en', { timeZone: s }).resolvedOptions().timeZone; } catch { return null; }
  }
  return null;
}
