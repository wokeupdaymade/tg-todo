import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, localNow, zonedToEpoch, relativeDateLabel } from '../src/time.ts';
import { compareTasks, isOverdue, normalizeTitle } from '../src/tasks.ts';
import { normalizeTz } from '../src/bot/router.ts';

test('zonedToEpoch round-trips and handles DST', () => {
  const tz = 'Europe/Berlin';
  const t = zonedToEpoch('2026-11-16', '14:30', tz);
  assert.equal(t, Date.UTC(2026, 10, 16, 13, 30));
  assert.deepEqual(localNow(t, tz), { date: '2026-11-16', time: '14:30', minutes: 870 });
  // Summer time (UTC+2)
  assert.equal(zonedToEpoch('2026-07-01', '09:00', tz), Date.UTC(2026, 6, 1, 7, 0));
  // Gap (02:30 doesn't exist on 2026-03-29): shifted forward to a real instant
  const gap = zonedToEpoch('2026-03-29', '02:30', tz);
  assert.equal(localNow(gap, tz).date, '2026-03-29');
  // Overlap (02:30 happens twice on 2026-10-25): the earlier one
  assert.equal(zonedToEpoch('2026-10-25', '02:30', tz), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(zonedToEpoch('2026-11-16', '23:59', 'Pacific/Auckland'), Date.UTC(2026, 10, 16, 10, 59));
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(relativeDateLabel('2026-11-17', '2026-11-16'), 'Tomorrow');
  assert.equal(relativeDateLabel('2027-01-04', '2026-11-16'), 'Mon, 4 Jan 2027');
});

test('ordering: date-only first, then timed ascending', () => {
  const ts = [
    { id: 1, date: '2026-11-16', time: '14:00' }, { id: 2, date: '2026-11-16', time: null },
    { id: 3, date: '2026-11-15', time: '23:00' }, { id: 4, date: '2026-11-16', time: '09:00' }, { id: 5, date: '2026-11-16', time: null },
  ];
  assert.deepEqual(ts.sort(compareTasks).map((t) => t.id), [3, 2, 5, 4, 1]);
});

test('overdue', () => {
  assert.equal(isOverdue({ date: '2026-11-15', time: null, completed_at: null }, '2026-11-16', 0), true);
  assert.equal(isOverdue({ date: '2026-11-16', time: null, completed_at: null }, '2026-11-16', 1439), false);
  assert.equal(isOverdue({ date: '2026-11-16', time: '09:00', completed_at: null }, '2026-11-16', 540), false);
  assert.equal(isOverdue({ date: '2026-11-16', time: '09:00', completed_at: null }, '2026-11-16', 541), true);
  assert.equal(isOverdue({ date: '2026-11-15', time: null, completed_at: 1 }, '2026-11-16', 0), false);
});

test('titles: first line, max 256', () => {
  assert.equal(normalizeTitle('  Buy milk  \nand eggs'), 'Buy milk');
  assert.equal(normalizeTitle('\n\n  x'), 'x');
  assert.equal(Array.from(normalizeTitle('я'.repeat(300))).length, 256);
});

test('time zone input', () => {
  assert.equal(normalizeTz('europe/berlin'), 'Europe/Berlin');
  assert.equal(normalizeTz('UTC+3'), 'Etc/GMT-3');
  assert.equal(normalizeTz('-5'), 'Etc/GMT+5');
  assert.equal(normalizeTz('utc'), 'UTC');
  assert.equal(normalizeTz('Mars/Olympus'), null);
});
