// Contextual date/time parser (spec §6.3). Shared by the bot and the Mini App.
// Returns null for anything invalid or ambiguous: callers re-prompt, never guess.
import { MONTHS, addDays, isValidDate, pad2, ymd } from './time.ts';

/**
 * Time: the last two numeric groups are hh and mm, whatever the separators
 * ("09.09.45" → 09:45, "9.45", "14:30", "14 30"); a single 3–4 digit group is
 * compact form ("930", "1430"); a single 1–2 digit group is a whole hour ("18").
 * AM/PM is respected.
 */
export function parseTime(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || s.length > 32) return null;
  let ampm: 'am' | 'pm' | null = null;
  const m = s.match(/\b([ap])\.?\s*m\.?$/) || s.match(/(?<=\d)\s*([ap])\.?\s*m\.?$/);
  if (m) { ampm = m[1] === 'a' ? 'am' : 'pm'; s = s.slice(0, m.index).trim(); }
  s = s.replace(/^at\s+/, '').replace(/\s*(h|hrs|o'?clock)$/, '');
  if (/[^\d\s.:,\-hH]/.test(s)) return null;
  const groups = s.match(/\d+/g);
  if (!groups) return null;
  let h: number, mi: number;
  if (groups.length >= 2) {
    const hs = groups[groups.length - 2], ms = groups[groups.length - 1];
    if (hs.length > 2 || ms.length !== 2) return null;
    h = Number(hs); mi = Number(ms);
  } else {
    const g = groups[0];
    if (g.length <= 2) { h = Number(g); mi = 0; }
    else if (g.length <= 4) { h = Number(g.slice(0, g.length - 2)); mi = Number(g.slice(-2)); }
    else return null;
  }
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return `${pad2(h)}:${pad2(mi)}`;
}

const MONTH_ALIASES: Record<string, number> = {};
MONTHS.forEach((name, i) => {
  const n = name.toLowerCase();
  MONTH_ALIASES[n] = i + 1;
  MONTH_ALIASES[n.slice(0, 3)] = i + 1;
  if (n.length > 4) MONTH_ALIASES[n.slice(0, 4)] = i + 1; // "sept"
});

function resolveYear(y: number | null, m: number, d: number, today: string): string | null {
  if (y !== null) {
    if (y < 100) y += 2000;
    return isValidDate(y, m, d) ? ymd(y, m, d) : null;
  }
  // No year: next non-past occurrence (Feb 29 → next leap year).
  const ty = Number(today.slice(0, 4));
  for (let yy = ty; yy <= ty + 8; yy++) {
    if (!isValidDate(yy, m, d)) continue;
    const c = ymd(yy, m, d);
    if (c >= today) return c;
  }
  return null;
}

/**
 * Date, day-first: "11.12", "11/12/2027", "11-12-27", "2027-12-11",
 * "11 Dec", "December 11", "Dec 11th, 2027", plus "today" / "tomorrow".
 * Without a year: the next non-past occurrence. A past date needs an explicit year.
 */
export function parseDate(input: string, today: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s || s.length > 40) return null;
  if (s === 'today') return today;
  if (s === 'tomorrow' || s === 'tmrw' || s === 'tmr') return addDays(today, 1);

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return resolveYear(Number(m[1]), Number(m[2]), Number(m[3]), today);

  m = s.match(/^(\d{1,2})\s*[./\- ]\s*(\d{1,2})(?:\s*[./\- ]\s*(\d{2}|\d{4}))?\.?$/);
  if (m) return resolveYear(m[3] ? Number(m[3]) : null, Number(m[2]), Number(m[1]), today);

  const word = '([a-z]+)\\.?';
  const day = '(\\d{1,2})(?:st|nd|rd|th)?';
  const year = '(?:,?\\s*(\\d{4}))?';
  m = s.match(new RegExp(`^${day}(?: of)?\\s*${word}${year}$`));
  if (m && MONTH_ALIASES[m[2]]) return resolveYear(m[3] ? Number(m[3]) : null, MONTH_ALIASES[m[2]], Number(m[1]), today);
  m = s.match(new RegExp(`^${word}\\s*${day}${year}$`));
  if (m && MONTH_ALIASES[m[1]]) return resolveYear(m[3] ? Number(m[3]) : null, MONTH_ALIASES[m[1]], Number(m[2]), today);
  return null;
}
