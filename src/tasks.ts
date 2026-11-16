// Task model helpers shared by the server and the Mini App (pure functions only).
import { timeToMinutes } from './time.ts';

export type Task = {
  id: number;
  title: string;
  date: string;          // YYYY-MM-DD
  time: string | null;   // HH:MM
  completed_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
};

export const TITLE_MAX = 256;

/** First line of the user's text, trimmed, at most 256 characters. */
export function normalizeTitle(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const chars = Array.from(first.replace(/\s+/g, ' '));
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : chars.join('');
}

/** Spec invariant: by date, then date-only tasks, then timed ascending; stable by id. */
export function compareTasks(a: Pick<Task, 'date' | 'time' | 'id'>, b: Pick<Task, 'date' | 'time' | 'id'>): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time !== b.time) {
    if (a.time === null) return -1;
    if (b.time === null) return 1;
    return a.time < b.time ? -1 : 1;
  }
  return a.id - b.id;
}

/** Overdue: incomplete and dated before today, or today with a time already passed. */
export function isOverdue(t: Pick<Task, 'date' | 'time' | 'completed_at'>, today: string, nowMinutes: number): boolean {
  if (t.completed_at) return false;
  if (t.date < today) return true;
  return t.date === today && t.time !== null && timeToMinutes(t.time) < nowMinutes;
}
