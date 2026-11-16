// Reminders for timed tasks (spec §7). Jobs live in the `reminders` table so
// restarts never lose or duplicate them. One row per task.
import { tx } from '../db.ts';
import { log } from '../log.ts';
import type { Task } from '../tasks.ts';
import { localNow, relativeDateLabel, zonedToEpoch } from '../time.ts';
import { widget } from '../widgets/index.ts';
import { type Ctx, DELETE_WINDOW, HOUR, MIN, safeDelete, scheduleDeletion } from './context.ts';
import type { ReminderSync, TaskService } from './tasks.ts';

export const REPEAT_EVERY = 5 * MIN;
export const MAX_REPEATS = 12;          // 12 repeats × 5 min = 1 h, then stop
export const SNOOZE = 15 * MIN;
export const MISSED_GRACE = HOUR;       // after downtime: send once if missed < 1 h

type Row = {
  task_id: number; user_id: number; status: string; next_fire_at: number | null; cycle_start_at: number | null;
  repeat_count: number; live_message_id: number | null; live_sent_at: number | null; revision: number;
};

export class ReminderService implements ReminderSync {
  private ctx: Ctx;
  private tasks: TaskService;
  private firing = false;

  constructor(ctx: Ctx, tasks: TaskService) {
    this.ctx = ctx;
    this.tasks = tasks;
    tasks.reminders = this;
  }

  row(taskId: number): Row | null {
    return (this.ctx.db.prepare('SELECT * FROM reminders WHERE task_id = ?').get(taskId) as Row | undefined) ?? null;
  }

  /**
   * Called inside every task write: cancel any live reminder and re-arm if the
   * task is incomplete, timed and still in the future. Returns the Telegram
   * cleanup to run after commit.
   */
  syncInTx(userId: number, task: Task, tz: string): (() => Promise<void>) | null {
    const old = this.row(task.id);
    const liveMsg = old?.live_message_id ?? null;
    const now = this.ctx.now();
    let fireAt: number | null = null;
    if (!task.completed_at && !task.deleted_at && task.time) {
      const at = zonedToEpoch(task.date, task.time, tz);
      if (at > now) fireAt = at;
    }
    if (fireAt === null) {
      if (old) this.ctx.db.prepare('DELETE FROM reminders WHERE task_id = ?').run(task.id);
    } else {
      this.ctx.db.prepare(`INSERT INTO reminders (task_id, user_id, status, next_fire_at, cycle_start_at, repeat_count, live_message_id, live_sent_at, revision)
        VALUES (?, ?, 'scheduled', ?, ?, 0, NULL, NULL, 0)
        ON CONFLICT(task_id) DO UPDATE SET status = 'scheduled', next_fire_at = excluded.next_fire_at, cycle_start_at = excluded.cycle_start_at,
          repeat_count = 0, live_message_id = NULL, live_sent_at = NULL`).run(task.id, userId, fireAt, fireAt);
    }
    if (!liveMsg) return null;
    return async () => { await safeDelete(this.ctx, userId, liveMsg); };
  }

  /** Fire every due reminder. Called by the scheduler. */
  async tick() {
    if (this.firing) return;
    this.firing = true;
    try {
      const due = this.ctx.db.prepare(`SELECT * FROM reminders WHERE next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 20`)
        .all(this.ctx.now()) as Row[];
      for (const r of due) {
        try { await this.fire(r); } catch (e) { log.error(`reminder ${r.task_id} failed`, e); }
      }
    } finally {
      this.firing = false;
    }
  }

  private async fire(r: Row) {
    const now = this.ctx.now();
    const task = this.tasks.get(r.user_id, r.task_id);
    if (!task || task.completed_at || task.deleted_at || !task.time) {
      this.ctx.db.prepare('DELETE FROM reminders WHERE task_id = ?').run(r.task_id);
      return;
    }
    const lateness = now - (r.next_fire_at ?? now);
    const cycleAge = now - (r.cycle_start_at ?? now);
    if (r.status === 'scheduled' && lateness > MISSED_GRACE) {
      // Missed by more than an hour (downtime): skip it, the task simply shows as overdue.
      this.ctx.db.prepare(`UPDATE reminders SET status = 'skipped', next_fire_at = NULL WHERE task_id = ?`).run(r.task_id);
      log.info(`reminder ${r.task_id} skipped (missed by ${Math.round(lateness / MIN)} min)`);
      return;
    }
    if (r.status === 'active' && cycleAge > MAX_REPEATS * REPEAT_EVERY + MISSED_GRACE / 4) {
      this.exhaust(r);
      return;
    }

    const tz = this.tasks.tz(r.user_id);
    const today = localNow(now, tz).date;
    const revision = r.revision + 1;
    const data = JSON.stringify({
      v: 1, r: revision, i: task.id, t: task.title.slice(0, 200), h: task.time,
      l: task.date === today ? '' : relativeDateLabel(task.date, today), s: 'a',
    });
    const msg = await this.ctx.tg.sendWidget({
      chat_id: r.user_id,
      html: widget('reminder').html,
      chat_data: data,
      caption: `⏰ ${task.time} — ${task.title}`.slice(0, 1024),
      allow_queries: true,
    });
    const repeat = r.status === 'active' ? r.repeat_count + 1 : 0;
    const done = repeat >= MAX_REPEATS;
    // Commit only if the task's reminder wasn't changed while we were sending.
    const committed = tx(this.ctx.db, () => {
      const cur = this.row(r.task_id);
      if (!cur || cur.next_fire_at !== r.next_fire_at || cur.status !== r.status) return false;
      this.ctx.db.prepare(`UPDATE reminders SET status = ?, next_fire_at = ?, repeat_count = ?, live_message_id = ?, live_sent_at = ?, revision = ?
        WHERE task_id = ?`).run(done ? 'exhausted' : 'active', done ? null : now + REPEAT_EVERY, repeat, msg.message_id, now, revision, r.task_id);
      return true;
    });
    if (!committed) { await safeDelete(this.ctx, r.user_id, msg.message_id); return; }
    // Each repeat replaces the previous reminder message.
    if (r.live_message_id) await safeDelete(this.ctx, r.user_id, r.live_message_id);
    if (done) scheduleDeletion(this.ctx, r.user_id, msg.message_id, now + DELETE_WINDOW, now);
  }

  private exhaust(r: Row) {
    this.ctx.db.prepare(`UPDATE reminders SET status = 'exhausted', next_fire_at = NULL WHERE task_id = ?`).run(r.task_id);
    if (r.live_message_id && r.live_sent_at) scheduleDeletion(this.ctx, r.user_id, r.live_message_id, r.live_sent_at + DELETE_WINDOW, r.live_sent_at);
  }

  // Widget actions -----------------------------------------------------------

  /** Validates that a widget query comes from the task's live reminder message. */
  ownsMessage(taskId: number, messageId: number | undefined): Row | null {
    const r = this.row(taskId);
    return r && messageId && r.live_message_id === messageId ? r : null;
  }

  async done(userId: number, taskId: number) {
    await this.tasks.complete(userId, taskId); // completion cancels the reminder and deletes its message
  }

  async snooze(userId: number, taskId: number) {
    const r = this.row(taskId);
    if (!r) return;
    const at = this.ctx.now() + SNOOZE;
    this.ctx.db.prepare(`UPDATE reminders SET status = 'scheduled', next_fire_at = ?, cycle_start_at = ?, repeat_count = 0, live_message_id = NULL, live_sent_at = NULL
      WHERE task_id = ?`).run(at, at, taskId);
    await safeDelete(this.ctx, userId, r.live_message_id);
  }

  async dismiss(userId: number, taskId: number) {
    const r = this.row(taskId);
    if (!r) return;
    this.ctx.db.prepare(`UPDATE reminders SET status = 'dismissed', next_fire_at = NULL, live_message_id = NULL, live_sent_at = NULL WHERE task_id = ?`).run(taskId);
    await safeDelete(this.ctx, userId, r.live_message_id);
  }
}
