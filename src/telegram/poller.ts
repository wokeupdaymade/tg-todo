// Long polling. Updates are processed strictly in order, one at a time, which
// keeps flow and preview state free of races for a single-user bot.
import { log } from '../log.ts';
import { type BotApi, type Update, sleep } from './api.ts';

export class Poller {
  private api: BotApi;
  private handler: (u: Update) => Promise<void>;
  private offset = 0;
  private stopped = false;

  constructor(api: BotApi, handler: (u: Update) => Promise<void>) {
    this.api = api;
    this.handler = handler;
  }

  stop() { this.stopped = true; }

  async run() {
    let backoff = 1000;
    while (!this.stopped) {
      let updates: Update[];
      try {
        updates = await this.api.call<Update[]>('getUpdates', {
          offset: this.offset, timeout: 25, allowed_updates: ['message', 'widget_query', 'shared_widget_query'],
        }, { timeoutMs: 40000 });
        backoff = 1000;
      } catch (e) {
        log.warn(`getUpdates failed; retrying in ${backoff / 1000}s`, e instanceof Error ? e.message : e);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try { await this.handler(u); } catch (e) { log.error(`update ${u.update_id} failed`, e); }
      }
    }
  }
}
