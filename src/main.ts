// Entry point: wires the store, services, Telegram transport, scheduler and HTTP.
import { loadConfig } from './config.ts';
import { backup, openDb } from './db.ts';
import { dirname } from 'node:path';
import { log } from './log.ts';
import { TelegramApi, Tg, type User } from './telegram/api.ts';
import { Poller } from './telegram/poller.ts';
import { type Ctx, runPendingDeletions } from './services/context.ts';
import { TaskService } from './services/tasks.ts';
import { ReminderService } from './services/reminders.ts';
import { PreviewService } from './services/preview.ts';
import { FlowService } from './services/flows.ts';
import { UiMode } from './services/ui.ts';
import { Router } from './bot/router.ts';
import { startHttp } from './http/server.ts';
import { widget } from './widgets/index.ts';

async function main() {
  const cfg = loadConfig();
  // Fail fast if the build is missing.
  widget('preview'); widget('creation'); widget('reminder');

  const db = openDb(cfg.dbPath);
  const tg = new Tg(new TelegramApi(cfg.botToken, cfg.apiBase));
  const me = await tg.api.call<User>('getMe');
  if (!me.username) throw new Error('bot has no username');
  log.info(`running as @${me.username}`);

  const ctx: Ctx = { cfg, db, tg, now: () => Date.now(), botUsername: me.username };
  const tasks = new TaskService(ctx);
  const ui = new UiMode(ctx, cfg.widgets);
  const reminders = new ReminderService(ctx, tasks, ui);
  const preview = new PreviewService(ctx, tasks, ui);
  const flows = new FlowService(ctx, tasks, ui);
  const router = new Router(ctx, { tasks, reminders, preview, flows }, cfg.allowedUserIds);

  // Bot chrome: the "Open App" menu button and the command list.
  await tg.api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open App', web_app: { url: cfg.publicUrl + '/' } } })
    .catch((e) => log.warn('setChatMenuButton failed', e instanceof Error ? e.message : e));
  await tg.api.call('setMyCommands', { commands: [
    { command: 'start', description: 'Show the task preview' },
    { command: 'cancel', description: 'Cancel the task being created' },
    { command: 'settings', description: 'Time zone' },
  ] }).catch((e) => log.warn('setMyCommands failed', e instanceof Error ? e.message : e));

  const server = startHttp({ ctx, tasks, botToken: cfg.botToken, allowed: cfg.allowedUserIds }, cfg.port);

  // Scheduler: reminders every 5 s; the rest every 20 s.
  let n = 0, busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await reminders.tick();
      if (n++ % 4 === 0) {
        await flows.expire();
        await preview.tick();          // rollover, layout upgrades, late times, midnight
        await runPendingDeletions(ctx);
        if (cfg.dbPath !== ':memory:') {
          const f = backup(db, process.env.BACKUP_DIR || dirname(cfg.dbPath) + '/backups', new Date().toISOString().slice(0, 10));
          if (f) log.info(`backup written: ${f}`);
        }
      }
    } catch (e) { log.error('scheduler tick failed', e); }
    finally { busy = false; }
  }, 5000);

  const poller = new Poller(tg.api, (u) => router.handle(u));
  const shutdown = () => {
    log.info('shutting down');
    poller.stop();
    clearInterval(timer);
    server.close();
    setTimeout(() => { db.close(); process.exit(0); }, 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown); // Windows: console window closed
  await poller.run();
}

main().catch((e) => { log.error('fatal', e); process.exit(1); });
