import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseTime } from '../src/parse.ts';

test('time: spec examples', () => {
  assert.equal(parseTime('09.09.45'), '09:45');
  assert.equal(parseTime('9.45'), '09:45');
  assert.equal(parseTime('14:30'), '14:30');
  assert.equal(parseTime('1430'), '14:30');
  assert.equal(parseTime('930'), '09:30');
  assert.equal(parseTime('9:45 AM'), '09:45');
  assert.equal(parseTime('9:45 pm'), '21:45');
  assert.equal(parseTime('12 am'), '00:00');
  assert.equal(parseTime('12pm'), '12:00');
  assert.equal(parseTime('9 p.m.'), '21:00');
  assert.equal(parseTime('14 30'), '14:30');
  assert.equal(parseTime('18'), '18:00');
  assert.equal(parseTime('at 7:05'), '07:05');
});

test('time: rejects invalid/ambiguous', () => {
  for (const s of ['24:00', '12:60', '13 pm', '0 am', 'tomorrow', '', 'abc 9:30', '12345', '9:5', '1.2.3.4x']) {
    assert.equal(parseTime(s), null, s);
  }
});

test('date: day-first numeric and month names', () => {
  const today = '2026-11-16';
  assert.equal(parseDate('11.12', today), '2026-12-11');
  assert.equal(parseDate('16.11', today), '2026-11-16');       // today is not past
  assert.equal(parseDate('15.11', today), '2027-11-15');       // rolls over
  assert.equal(parseDate('September 11', today), '2027-09-11');
  assert.equal(parseDate('11 sep', today), '2027-09-11');
  assert.equal(parseDate('Dec 24th', today), '2026-12-24');
  assert.equal(parseDate('24 December 2026', today), '2026-12-24');
  assert.equal(parseDate('1/2/2025', today), '2025-02-01');    // explicit year: past allowed
  assert.equal(parseDate('2025-02-01', today), '2025-02-01');
  assert.equal(parseDate('1.2.25', today), '2025-02-01');
  assert.equal(parseDate('today', today), today);
  assert.equal(parseDate('Tomorrow', today), '2026-11-17');
  assert.equal(parseDate('29.02', today), '2028-02-29');
});

test('date: rejects invalid', () => {
  const today = '2026-11-16';
  for (const s of ['31.11', '32.1', '1.13', 'foo', '14:30', 'Smarch 3', '', '30 feb 2027']) assert.equal(parseDate(s, today), null, s);
});
