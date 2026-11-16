// Test harness: in-memory DB, controllable clock, fake Telegram Bot API.
import { openDb } from '../src/db.ts';
import { Tg, TelegramError, type BotApi, type Update } from '../src/telegram/api.ts';
import type { Ctx } from '../src/services/context.ts';
import { TaskService } from '../src/services/tasks.ts';
import { ReminderService } from '../src/services/reminders.ts';
import { PreviewService } from '../src/services/preview.ts';
import { FlowService } from '../src/services/flows.ts';
import { Router } from '../src/bot/router.ts';

export type Call = { method: string; params: Record<string, any>; result: any };

export class FakeApi implements BotApi {
  calls: Call[] = [];
  nextId = 1000;
  live = new Set<number>();           // message ids currently in the chat
  failDelete = new Set<number>();
  async call<T>(method: string, params: Record<string, any> = {}): Promise<T> {
    let result: any = true;
    if (method === 'sendWidget' || method === 'sendMessage') {
      const id = ++this.nextId;
      this.live.add(id);
      result = { message_id: id, chat: { id: params.chat_id, type: 'private' }, date: 0 };
    } else if (method === 'deleteMessage') {
      if (this.failDelete.has(params.message_id)) throw new TelegramError(method, 400, "Bad Request: message can't be deleted");
      this.live.delete(params.message_id);
    } else if (method === 'deleteMessages') {
      for (const id of params.message_ids) this.live.delete(id);
    } else if (method === 'editMessageWidgetData') {
      if (!this.live.has(params.message_id)) throw new TelegramError(method, 400, 'Bad Request: message to edit not found');
    }
    this.calls.push({ method, params, result });
    return result as T;
  }
  of(method: string) { return this.calls.filter((c) => c.method === method); }
  last(method: string) { const a = this.of(method); return a[a.length - 1]; }
  clear() { this.calls = []; }
}

export const USER = 4242;

export function harness(start = Date.UTC(2026, 10, 16, 9, 0), tz = 'Europe/Berlin') {
  const clock = { t: start };
  const api = new FakeApi();
  const db = openDb(':memory:');
  const ctx: Ctx = { cfg: { defaultTz: tz, pinPreview: false, publicUrl: 'https://x.test' }, db, tg: new Tg(api), now: () => clock.t, botUsername: 'todo_bot' };
  const tasks = new TaskService(ctx);
  const reminders = new ReminderService(ctx, tasks);
  const preview = new PreviewService(ctx, tasks);
  const flows = new FlowService(ctx, tasks);
  const router = new Router(ctx, { tasks, reminders, preview, flows }, new Set([USER]));
  let uid = 1, mid = 1;
  const send = async (text: string | undefined, from = USER) => {
    const message: any = { message_id: mid++, from: { id: from, is_bot: false, first_name: 'U' }, chat: { id: from, type: 'private' }, date: 0 };
    if (text !== undefined) message.text = text;
    api.live.add(message.message_id);
    await router.handle({ update_id: uid++, message } as Update);
    await preview.flush();
    return message.message_id as number;
  };
  const query = async (messageId: number, data: string, from = USER) => {
    await router.handle({ update_id: uid++, widget_query: { id: `q${uid}`, from: { id: from, is_bot: false, first_name: 'U' }, chat: { id: from, type: 'private' }, message_id: messageId, chat_instance: '1', data } } as Update);
    await preview.flush();
    const a = api.last('answerWidgetQuery');
    return a ? JSON.parse(a.params.data) : null;
  };
  const advance = async (ms: number) => { clock.t += ms; await reminders.tick(); await preview.tick(); await preview.flush(); };
  return { clock, api, db, ctx, tasks, reminders, preview, flows, router, send, query, advance };
}

export const state = (call: Call | undefined) => (call ? JSON.parse(call.params.chat_data) : null);
