// SQLite storage (node:sqlite). Migrations are append-only and never destructive:
// stored tasks must survive restarts and upgrades.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,            -- Telegram user id (= private chat id)
    tz TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,                -- YYYY-MM-DD, user's local calendar
    time TEXT,                         -- HH:MM or NULL (date-only)
    completed_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX tasks_user_active ON tasks(user_id, completed_at, deleted_at, date);
  CREATE INDEX tasks_user_completed ON tasks(user_id, completed_at DESC);

  CREATE TABLE reminders (
    task_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,              -- scheduled | active | exhausted | dismissed | skipped
    next_fire_at INTEGER,              -- epoch ms; NULL when not scheduled
    cycle_start_at INTEGER,            -- start of the current repeat cycle (task time or snooze end)
    repeat_count INTEGER NOT NULL DEFAULT 0,
    live_message_id INTEGER,
    live_sent_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX reminders_due ON reminders(next_fire_at);

  CREATE TABLE flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,              -- open | saved | cancelled
    step TEXT NOT NULL,                -- date | time
    title TEXT NOT NULL,
    date TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    source_message_id INTEGER,         -- the user's original text
    widget_message_id INTEGER,
    prompt_message_id INTEGER,         -- message carrying the current reply keyboard
    hint_message_id INTEGER,           -- last "couldn't read that" message
    calendar_hint INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX flows_user_open ON flows(user_id, status);

  CREATE TABLE previews (
    user_id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    html_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    last_data TEXT
  );

  -- Messages to delete later (transient notices, stranded messages). Retried until ~47 h old.
  CREATE TABLE pending_deletions (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this build (v${MIGRATIONS.length}). Refusing to run.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Daily snapshot via VACUUM INTO; keeps the newest `keep` files. */
export function backup(db: DB, dir: string, stamp: string, keep = 14): string | null {
  mkdirSync(dir, { recursive: true });
  const file = `${dir.replace(/\/+$/, '')}/todo-${stamp}.sqlite`;
  if (existsSync(file)) return null;
  db.prepare('VACUUM INTO ?').run(file);
  const old = readdirSync(dir).filter((f) => /^todo-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(`${dir}/${f}`, { force: true });
  return file;
}
