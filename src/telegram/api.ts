// Thin Bot API client (Bot API 10.4). Hand-written because no library covers
// widgets yet. All calls are JSON POSTs; flood waits are retried transparently.
import { log } from '../log.ts';

export class TelegramError extends Error {
  code: number;
  description: string;
  retryAfter?: number;
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`${method}: ${code} ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
  get notModified() { return /message is not modified/i.test(this.description); }
  get messageGone() { return /message to (edit|delete) not found|message can't be (deleted|edited)|MESSAGE_ID_INVALID|message not found/i.test(this.description); }
  get queryTooOld() { return /query is too old|QUERY_ID_INVALID/i.test(this.description); }
}

export type User = { id: number; is_bot: boolean; first_name: string; username?: string; language_code?: string };
export type Chat = { id: number; type: string };
export type Message = {
  message_id: number;
  from?: User;
  chat: Chat;
  date: number;
  text?: string;
  reply_to_message?: Message;
  pinned_message?: Message;
  widget?: unknown;
};
export type WidgetQuery = {
  id: string;
  from: User;
  chat?: Chat;
  message_id?: number;
  inline_message_id?: string;
  chat_instance: string;
  type?: { type: string };
  data: string;
  widget_id?: string;
};
export type Update = {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  widget_query?: WidgetQuery;
  shared_widget_query?: { id: string; from: User; data: string; widget_id: string };
};

export type ReplyMarkup =
  | { keyboard: { text: string }[][]; resize_keyboard?: boolean; is_persistent?: boolean; one_time_keyboard?: boolean; input_field_placeholder?: string }
  | { remove_keyboard: true };

export type SendWidgetParams = {
  chat_id: number;
  html: string;
  chat_data?: string;
  public_data?: string;
  caption?: string;
  allow_queries?: boolean;
  disable_notification?: boolean;
  reply_markup?: ReplyMarkup;
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  height?: number;
};

export interface BotApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
}

export class TelegramApi implements BotApi {
  private base: string;
  constructor(token: string, apiBase = 'https://api.telegram.org') {
    this.base = `${apiBase}/bot${token}`;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
      let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        const res = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        });
        body = await res.json() as typeof body;
      } catch (e) {
        clearTimeout(timer);
        if (attempt < 2 && method !== 'getUpdates') { await sleep(500 * (attempt + 1)); continue; }
        throw e;
      }
      clearTimeout(timer);
      if (body.ok) return body.result as T;
      const retry = body.parameters?.retry_after;
      if (body.error_code === 429 && retry && retry <= 30 && attempt < 3) {
        log.warn(`flood wait on ${method}: ${retry}s`);
        await sleep(retry * 1000 + 100);
        continue;
      }
      throw new TelegramError(method, body.error_code ?? 0, body.description ?? 'unknown error', retry);
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Typed helpers ---------------------------------------------------------------

export class Tg {
  api: BotApi;
  constructor(api: BotApi) { this.api = api; }

  sendWidget(p: SendWidgetParams) { return this.api.call<Message>('sendWidget', p); }
  editWidgetData(chat_id: number, message_id: number, chat_data: string) {
    return this.api.call<true>('editMessageWidgetData', { chat_id, message_id, chat_data });
  }
  answerWidgetQuery(widget_query_id: string, data?: string) {
    return this.api.call<true>('answerWidgetQuery', data === undefined ? { widget_query_id } : { widget_query_id, data }, { timeoutMs: 10000 });
  }
  sendMessage(chat_id: number, text: string, extra: Record<string, unknown> = {}) {
    return this.api.call<Message>('sendMessage', { chat_id, text, ...extra });
  }
  deleteMessage(chat_id: number, message_id: number) { return this.api.call<true>('deleteMessage', { chat_id, message_id }); }
  deleteMessages(chat_id: number, message_ids: number[]) { return this.api.call<true>('deleteMessages', { chat_id, message_ids }); }
  pinChatMessage(chat_id: number, message_id: number) {
    return this.api.call<true>('pinChatMessage', { chat_id, message_id, disable_notification: true });
  }
  editMessageCaption(chat_id: number, message_id: number, caption: string) {
    return this.api.call('editMessageCaption', { chat_id, message_id, caption });
  }
}
