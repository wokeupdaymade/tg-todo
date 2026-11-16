// The single authoritative task store. Every surface (Mini App API, preview
// widget, creation flows, reminders) mutates tasks through this service, which
// enforces optimistic concurrency and fans out side effects (reminders, preview).
import { tx } from '../db.ts';
import { type Task, normalizeTitle, compareTasks } from '../tasks.ts';
import { isValidDate, isValidTimeZone, localNow } from '../time.ts';
import type { Ctx } from './context.ts';

export class ConflictError extends Error {
  current: Task | null;
  constructor(current: Task | null) { super('version conflict'); this.current = current; }
}
export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export type TaskChange = { userId: number; task: Task; kind: 'create' | 'update' | 'complete' | 'uncomplete' | 'delete' | 'undelete' };

/** Reminder hook: runs inside the write transaction, returns post-commit work. */
export interface ReminderSync {
  syncInTx(userId: number, task: Task, tz: string): (() => Promise<void>) | null;
}

export type NewTask = { title: string; date: string; time: string | null };
export type TaskPatch = { title?: string; date?: string; time?: string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkDate(d: unknown): string {
  if (typeof d !== 'string' || !DATE_RE.test(d)) throw new ValidationError('invalid date');
  const [y, m, dd] = d.split('-').map(Number);
  if (!isValidDate(y, m, dd)) throw new ValidationError('invalid date');
  return d;
}
function checkTime(t: unknown): string | null {
  if (t === null) return null;
  if (typeof t !== 'string' || !TIME_RE.test(t)) throw new ValidationError('invalid time');
  return t;
}
function checkTitle(t: unknown): string {
  if (typeof t !== 'string') throw new ValidationError('invalid title');
  const n = normalizeTitle(t);
  if (!n) throw new ValidationError('title is empty');
  return n;
}

export class TaskService {
  private ctx: Ctx;
  reminders: ReminderSync | null = null;
  private listeners: ((c: TaskChange) => void)[] = [];

  constructor(ctx: Ctx) { this.ctx = ctx; }

  onChange(fn: (c: TaskChange) => void) { this.listeners.push(fn); }

  // Users ---------------------------------------------------------------------

  ensureUser(userId: number): { id: number; tz: string; created: boolean } {
    const row = this.ctx.db.prepare('SELECT id, tz FROM users WHERE id = ?').get(userId) as { id: number; tz: string } | undefined;
    if (row) return { ...row, created: false };
    this.ctx.db.prepare('INSERT INTO users (id, tz, created_at) VALUES (?, ?, ?)').run(userId, this.ctx.cfg.defaultTz, this.ctx.now());
    return { id: userId, tz: this.ctx.cfg.defaultTz, created: true };
  }

  tz(userId: number): string {
    const row = this.ctx.db.prepare('SELECT tz FROM users WHERE id = ?').get(userId) as { tz: string } | undefined;
    return row?.tz ?? this.ctx.cfg.defaultTz;
  }

  userIds(): number[] {
    return (this.ctx.db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id);
  }

  /** Change the user's time zone and re-arm all reminders in the new zone. */
  async setTz(userId: number, tz: string) {
    if (!isValidTimeZone(tz)) throw new ValidationError('invalid time zone');
    const post: (() => Promise<void>)[] = [];
    tx(this.ctx.db, () => {
      this.ctx.db.prepare('UPDATE users SET tz = ? WHERE id = ?').run(tz, userId);
      for (const t of this.listActive(userId)) {
        const p = this.reminders?.syncInTx(userId, t, tz);
        if (p) post.push(p);
      }
    });
    for (const p of post) await p();
  }

  today(userId: number) { return localNow(this.ctx.now(), this.tz(userId)); }

  // Reads ---------------------------------------------------------------------

  get(userId: number, id: number): Task | null {
    return (this.ctx.db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined) ?? null;
  }

  /** All incomplete, non-deleted tasks, in canonical order. */
  listActive(userId: number): Task[] {
    const rows = this.ctx.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NULL AND deleted_at IS NULL').all(userId) as Task[];
    return rows.sort(compareTasks);
  }

  /** Tasks completed at or after `since` (still inside an undo window). */
  listRecentlyCompleted(userId: number, since: number): Task[] {
    return this.ctx.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND completed_at >= ?').all(userId, since) as Task[];
  }

  /** Completed tasks, newest first; cursor-based for continuous scrolling. */
  listHistory(userId: number, before: { completedAt: number; id: number } | null, limit = 50): Task[] {
    if (!before) {
      return this.ctx.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL AND deleted_at IS NULL ORDER BY completed_at DESC, id DESC LIMIT ?')
        .all(userId, limit) as Task[];
    }
    return this.ctx.db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL AND deleted_at IS NULL
      AND (completed_at < ? OR (completed_at = ? AND id < ?)) ORDER BY completed_at DESC, id DESC LIMIT ?`)
      .all(userId, before.completedAt, before.completedAt, before.id, limit) as Task[];
  }

  // Writes --------------------------------------------------------------------

  async create(userId: number, input: NewTask): Promise<Task> {
    const title = checkTitle(input.title), date = checkDate(input.date), time = checkTime(input.time ?? null);
    const now = this.ctx.now();
    return this.write(userId, 'create', () => {
      const r = this.ctx.db.prepare('INSERT INTO tasks (user_id, title, date, time, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .run(userId, title, date, time, now, now);
      return this.get(userId, Number(r.lastInsertRowid))!;
    });
  }

  async update(userId: number, id: number, version: number | undefined, patch: TaskPatch): Promise<Task> {
    const fields: string[] = [], vals: (string | null)[] = [];
    if (patch.title !== undefined) { fields.push('title = ?'); vals.push(checkTitle(patch.title)); }
    if (patch.date !== undefined) { fields.push('date = ?'); vals.push(checkDate(patch.date)); }
    if (patch.time !== undefined) { fields.push('time = ?'); vals.push(checkTime(patch.time)); }
    if (!fields.length) throw new ValidationError('nothing to update');
    return this.mutate(userId, id, version, 'update', `${fields.join(', ')}`, vals, (t) => t.deleted_at === null);
  }

  complete(userId: number, id: number, version?: number) {
    return this.mutate(userId, id, version, 'complete', 'completed_at = ?', [this.ctx.now()], (t) => t.deleted_at === null && t.completed_at === null);
  }
  uncomplete(userId: number, id: number, version?: number) {
    return this.mutate(userId, id, version, 'uncomplete', 'completed_at = NULL', [], (t) => t.deleted_at === null && t.completed_at !== null);
  }
  remove(userId: number, id: number, version?: number) {
    return this.mutate(userId, id, version, 'delete', 'deleted_at = ?', [this.ctx.now()], (t) => t.deleted_at === null);
  }
  undelete(userId: number, id: number, version?: number) {
    return this.mutate(userId, id, version, 'undelete', 'deleted_at = NULL', [], (t) => t.deleted_at !== null);
  }

  private async mutate(userId: number, id: number, version: number | undefined, kind: TaskChange['kind'],
    set: string, vals: (string | number | null)[], allowed: (t: Task) => boolean): Promise<Task> {
    return this.write(userId, kind, () => {
      const cur = this.get(userId, id);
      if (!cur) throw new NotFoundError('task not found');
      if (version !== undefined && cur.version !== version) throw new ConflictError(cur);
      if (!allowed(cur)) throw new ConflictError(cur);
      const r = this.ctx.db.prepare(`UPDATE tasks SET ${set}, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND version = ?`)
        .run(...vals, this.ctx.now(), id, userId, cur.version);
      if (r.changes !== 1) throw new ConflictError(this.get(userId, id));
      return this.get(userId, id)!;
    });
  }

  private async write(userId: number, kind: TaskChange['kind'], fn: () => Task): Promise<Task> {
    let post: (() => Promise<void>) | null = null;
    const task = tx(this.ctx.db, () => {
      const t = fn();
      post = this.reminders?.syncInTx(userId, t, this.tz(userId)) ?? null;
      return t;
    });
    for (const l of this.listeners) l({ userId, task, kind });
    if (post) await (post as () => Promise<void>)();
    return task;
  }
}
