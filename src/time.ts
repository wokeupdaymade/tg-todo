// Time-zone utilities. All "today"/"now" logic is computed server-side in the
// user's configured IANA time zone. Dates are 'YYYY-MM-DD' strings, times 'HH:MM'.
// This module is shared with the Mini App bundle: keep it dependency-free.

export type LocalNow = { date: string; time: string; minutes: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function parts(epochMs: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

/** Local calendar date and wall-clock time in `tz` at `epochMs`. */
export function localNow(epochMs: number, tz: string): LocalNow {
  const p = parts(epochMs, tz);
  return { date: ymd(p.y, p.mo, p.d), time: `${pad2(p.h)}:${pad2(p.mi)}`, minutes: p.h * 60 + p.mi };
}

/** Offset of tz from UTC at the given instant, in minutes. */
function offsetAt(epochMs: number, tz: string): number {
  const p = parts(epochMs, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

/**
 * Epoch ms of a local wall-clock time in tz. For times that don't exist (DST gap)
 * the result is shifted forward; for ambiguous times (DST overlap) the earlier
 * instant is returned.
 */
export function zonedToEpoch(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = offsetAt(guess - 0, tz);
  let t = guess - o1 * 60000;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2 * 60000;
  // Prefer the earlier instant in an overlap.
  const earlier = t - 3600000;
  if (localNow(earlier, tz).time === time && localNow(earlier, tz).date === date) return earlier;
  return t;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function isValidDate(y: number, m: number, d: number): boolean {
  if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1970 && y <= 9999)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function weekday(date: string): number { // 0 = Monday … 6 = Sunday
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "Mon, 16 Nov" (adds the year if it differs from today's). */
export function shortDateLabel(date: string, today?: string): string {
  const [y, m, d] = date.split('-').map(Number);
  let s = `${WEEKDAYS[weekday(date)].slice(0, 3)}, ${d} ${MONTHS[m - 1].slice(0, 3)}`;
  if (today && today.slice(0, 4) !== date.slice(0, 4)) s += ` ${y}`;
  return s;
}

/** "Today" / "Tomorrow" / "Yesterday" / short label. */
export function relativeDateLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  return shortDateLabel(date, today);
}

export const timeToMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
