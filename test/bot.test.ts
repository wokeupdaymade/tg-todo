import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, state, USER } from './helpers.ts';
import { MIN, HOUR } from '../src/services/context.ts';
import { buildPreviewData } from '../src/services/preview.ts';
import { bytes } from '../src/widgets/index.ts';
import type { Task } from '../src/tasks.ts';

const lastReminder = (h: ReturnType<typeof harness>) => h.api.of('sendWidget').filter((c) => c.params.caption?.startsWith('⏰')).pop()!;

// Clock starts at 2026-11-16 10:00 Europe/Berlin (09:00 UTC).

test('chat flow via widget taps: title → Today → 14:30 saves and cleans up', async () => {
  const h = harness();
  const src = await h.send('Buy milk\nsecond line ignored');
  const w = h.api.last('sendWidget');
  assert.equal(w.params.caption, 'New task: Buy milk');
  assert.equal(w.params.allow_queries, true);
  assert.deepEqual(w.params.reply_markup.keyboard[0].map((b: any) => b.text), ['Today', 'Tomorrow', 'Other Date']);
  const s0 = state(w);
  assert.equal(s0.s, 'd');
  assert.equal(s0.t, 'Buy milk');

  const widgetId = w.result.message_id;
  assert.deepEqual(await h.query(widgetId, `fd.${s0.i}.${s0.r}.t`), { ok: 1 });
  const s1 = JSON.parse(h.api.last('editMessageWidgetData').params.chat_data);
  assert.equal(s1.s, 't');
  assert.equal(s1.d, '2026-11-16');
  // A prompt with the time keyboard was sent.
  const prompt = h.api.last('sendMessage');
  assert.equal(prompt.params.reply_markup.keyboard[0][0].text, 'No Specific Time');

  // Stale revision is rejected.
  assert.ok((await h.query(widgetId, `ft.${s1.i}.${s0.r}.1430`)).e);
  assert.deepEqual(await h.query(widgetId, `ft.${s1.i}.${s1.r}.1430`), { ok: 1 });

  const [t] = h.tasks.listActive(USER);
  assert.equal(t.title, 'Buy milk');
  assert.equal(t.date, '2026-11-16');
  assert.equal(t.time, '14:30');
  // Cleanup: user message, widget, prompt deleted; keyboard removed (sent + deleted).
  const deleted = h.api.of('deleteMessages').flatMap((c) => c.params.message_ids);
  for (const id of [src, widgetId, prompt.result.message_id]) assert.ok(deleted.includes(id), `deleted ${id}`);
  const kb = h.api.calls.find((c) => c.method === 'sendMessage' && c.params.reply_markup?.remove_keyboard);
  assert.ok(kb);
  assert.ok(!h.api.live.has(kb!.result.message_id));
  assert.equal(h.flows.openFlow(USER), null);
  // Reminder armed for 14:30 Berlin.
  assert.equal(h.reminders.row(t.id)!.next_fire_at, Date.UTC(2026, 10, 16, 13, 30));
});

test('typed input: dates/times parsed by step, bad input re-prompts and keeps the flow', async () => {
  const h = harness();
  await h.send('Dentist');
  const typedDate = await h.send('11.12');
  assert.ok(!h.api.live.has(typedDate));
  let f = h.flows.openFlow(USER)!;
  assert.equal(f.step, 'time');
  assert.equal(f.date, '2026-12-11');

  await h.send('half past nine');           // unparseable time
  f = h.flows.openFlow(USER)!;
  assert.ok(f, 'flow kept');
  assert.equal(f.step, 'time');
  assert.match(h.api.last('sendMessage').params.text, /Couldn't read/);
  assert.equal(h.tasks.listActive(USER).length, 0, 'never became a task');
  await h.send('still nope');               // second bad input re-prompts again
  assert.ok(h.flows.openFlow(USER));

  await h.send('9.45');
  const [t] = h.tasks.listActive(USER);
  assert.equal(t.time, '09:45');
  assert.equal(t.date, '2026-12-11');
  assert.equal(h.flows.openFlow(USER), null);
  // Hints were cleaned up
  assert.equal(h.api.live.size, 1, `only the preview remains, live: ${[...h.api.live]}`);
});

test('reply-keyboard shortcuts drive the flow; Back keeps title and date', async () => {
  const h = harness();
  await h.send('Call mom');
  await h.send('Tomorrow');
  assert.equal(h.flows.openFlow(USER)!.date, '2026-11-17');
  await h.send('Back');
  const f = h.flows.openFlow(USER)!;
  assert.equal(f.step, 'date');
  assert.equal(f.title, 'Call mom');
  await h.send('Other Date');
  assert.equal(JSON.parse(h.api.last('editMessageWidgetData').params.chat_data).c, 1, 'widget told to open the calendar');
  await h.send('Today');
  await h.send('No Specific Time');
  const [t] = h.tasks.listActive(USER);
  assert.equal(t.date, '2026-11-16');
  assert.equal(t.time, null);
  assert.equal(h.reminders.row(t.id), null, 'date-only tasks have no reminder');
});

test('cancel removes everything and creates nothing', async () => {
  const h = harness();
  await h.send('Thing');
  await h.send('Cancel');
  assert.equal(h.tasks.listActive(USER).length, 0);
  assert.equal(h.flows.openFlow(USER), null);
  await h.send('Other thing');
  await h.send('/cancel');
  assert.equal(h.flows.openFlow(USER), null);
  assert.equal(h.api.live.size, 1, 'only the preview remains');
});

test('stray shortcut labels never become tasks; others are ignored', async () => {
  const h = harness();
  await h.send('Today');
  assert.equal(h.flows.openFlow(USER), null);
  assert.equal(h.tasks.listActive(USER).length, 0);
  h.api.clear();
  await h.send('hello', 999);   // not whitelisted
  assert.equal(h.api.calls.length, 0);
  await h.send(undefined);      // sticker etc.
  assert.equal(h.api.of('deleteMessage').length, 1);
});

test('abandoned flows auto-cancel after 6 h', async () => {
  const h = harness();
  await h.send('Forgotten');
  h.clock.t += 6 * HOUR + MIN;
  await h.flows.expire();
  assert.equal(h.flows.openFlow(USER), null);
});

test('reminders: fire, repeat every 5 min replacing the old one, stop after 12 repeats', async () => {
  const h = harness();
  const t = await h.tasks.create(USER, { title: 'Pills', date: '2026-11-16', time: '10:30' });
  await h.advance(29 * MIN);
  assert.equal(h.api.of('sendWidget').filter((c) => c.params.caption?.startsWith('⏰')).length, 0);
  await h.advance(1 * MIN);
  const first = h.api.last('sendWidget');
  assert.equal(first.params.caption, '⏰ 10:30 — Pills');
  assert.equal(state(first).i, t.id);
  let liveIds = [first.result.message_id];
  for (let i = 1; i <= 12; i++) {
    await h.advance(5 * MIN);
    const m = h.api.last('sendWidget');
    assert.ok(!h.api.live.has(liveIds[liveIds.length - 1]), 'previous reminder deleted');
    liveIds.push(m.result.message_id);
  }
  assert.equal(h.reminders.row(t.id)!.status, 'exhausted');
  const sends = h.api.of('sendWidget').filter((c) => c.params.caption?.startsWith('⏰')).length;
  await h.advance(30 * MIN);
  assert.equal(h.api.of('sendWidget').filter((c) => c.params.caption?.startsWith('⏰')).length, sends, 'no more after max');
  assert.equal(sends, 13);
  assert.ok(h.tasks.get(USER, t.id)!.completed_at === null, 'task stays active');
});

test('reminder actions: snooze 15 min, done completes, dismiss stops; edits re-arm', async () => {
  const h = harness();
  const t = await h.tasks.create(USER, { title: 'Call', date: '2026-11-16', time: '10:05' });
  await h.advance(5 * MIN);
  let msg = lastReminder(h);
  let st = state(msg);
  assert.deepEqual(await h.query(msg.result.message_id, `rs.${t.id}.${st.r}`), { ok: 1 });
  assert.ok(!h.api.live.has(msg.result.message_id));
  await h.advance(14 * MIN);
  assert.equal(lastReminder(h).result.message_id, msg.result.message_id, 'nothing during snooze');
  await h.advance(1 * MIN);
  msg = lastReminder(h);
  st = state(msg);
  assert.equal(st.i, t.id);
  // Queries from other messages are refused.
  assert.ok((await h.query(12345, `rd.${t.id}.${st.r}`)).e);
  assert.deepEqual(await h.query(msg.result.message_id, `rd.${t.id}.${st.r}`), { ok: 1 });
  assert.ok(h.tasks.get(USER, t.id)!.completed_at);
  assert.ok(!h.api.live.has(msg.result.message_id));
  assert.equal(h.reminders.row(t.id), null);

  // Dismiss, then edit the time → re-armed.
  const t2 = await h.tasks.create(USER, { title: 'Walk', date: '2026-11-16', time: '10:30' });
  await h.advance(10 * MIN);
  const m2 = lastReminder(h);
  await h.query(m2.result.message_id, `rx.${t2.id}.${state(m2).r}`);
  assert.equal(h.reminders.row(t2.id)!.status, 'dismissed');
  await h.advance(10 * MIN);
  assert.equal(lastReminder(h).result.message_id, m2.result.message_id);
  const cur = h.tasks.get(USER, t2.id)!;
  await h.tasks.update(USER, t2.id, cur.version, { time: '12:00' });
  assert.equal(h.reminders.row(t2.id)!.status, 'scheduled');
  // Undo-complete re-arms if still in the future; a past time doesn't.
  await h.tasks.complete(USER, t2.id);
  assert.equal(h.reminders.row(t2.id), null);
  await h.tasks.uncomplete(USER, t2.id);
  assert.equal(h.reminders.row(t2.id)!.status, 'scheduled');
  const past = await h.tasks.create(USER, { title: 'Too late', date: '2026-11-16', time: '08:00' });
  assert.equal(h.reminders.row(past.id), null);
});

test('reminders after downtime: < 1 h late sends once, > 1 h late skips', async () => {
  const h = harness();
  const a = await h.tasks.create(USER, { title: 'A', date: '2026-11-16', time: '10:10' });
  const b = await h.tasks.create(USER, { title: 'B', date: '2026-11-16', time: '11:00' });
  h.clock.t += 2 * HOUR + 5 * MIN; // "down" until 12:05
  await h.reminders.tick();
  assert.equal(h.reminders.row(a.id)!.status, 'skipped');
  assert.equal(h.reminders.row(b.id)!.status, 'skipped');
  const c = await h.tasks.create(USER, { title: 'C', date: '2026-11-16', time: '12:10' });
  h.clock.t += 40 * MIN;
  await h.reminders.tick();
  assert.equal(h.reminders.row(c.id)!.status, 'active');
});

test('preview: content, complete with undo via widget, hidden after the undo window', async () => {
  const h = harness();
  await h.send('/start');
  const p = h.api.last('sendWidget');
  assert.equal(p.params.disable_notification, true);
  assert.ok(p.params.caption);
  const pid = p.result.message_id;
  const a = await h.tasks.create(USER, { title: 'Late one', date: '2026-11-16', time: '09:00' });
  await h.tasks.create(USER, { title: 'Date only', date: '2026-11-16', time: null });
  await h.tasks.create(USER, { title: 'Later', date: '2026-11-16', time: '18:00' });
  await h.tasks.create(USER, { title: 'Next week', date: '2026-11-23', time: '08:00' });
  await h.tasks.create(USER, { title: 'Old', date: '2026-11-10', time: null });
  await h.preview.flush();
  let s = state(h.api.last('editMessageWidgetData'));
  assert.deepEqual(s.T.map((r: any) => r[1]), ['Date only', 'Late one', 'Later']);
  assert.equal(s.T[1][3] & 2, 2, 'late flag');
  assert.deepEqual(s.O.map((r: any) => r[2]), ['Mon, 23 Nov · 08:00']);
  assert.equal(s.n, 1);
  assert.equal(s.b, 'todo_bot');

  assert.deepEqual(await h.query(pid, `pc.${a.id}`), { ok: 1 });
  s = state(h.api.last('editMessageWidgetData'));
  assert.equal(s.T.find((r: any) => r[0] === a.id)[3] & 1, 1, 'shown as completed during undo window');
  assert.deepEqual(await h.query(pid, `pu.${a.id}`), { ok: 1 });
  assert.equal(h.tasks.get(USER, a.id)!.completed_at, null);
  await h.query(pid, `pc.${a.id}`);
  await h.advance(6000);
  s = state(h.api.last('editMessageWidgetData'));
  assert.ok(!s.T.some((r: any) => r[0] === a.id), 'hidden after undo window');
  // Queries from a message that isn't the current preview are refused.
  assert.ok((await h.query(pid + 999, `pc.${a.id}`)).e);
});

test('preview rolls over before 48 h and marks stranded copies superseded', async () => {
  const h = harness();
  await h.send('/start');
  const first = h.api.last('sendWidget').result.message_id;
  await h.advance(46 * HOUR);
  assert.equal(h.preview.row(USER)!.message_id, first);
  await h.advance(31 * MIN);
  const second = h.preview.row(USER)!.message_id;
  assert.notEqual(second, first);
  assert.ok(!h.api.live.has(first), 'old preview deleted');

  // Missed window (bot was down): deletion fails → old copy flipped to its superseded view.
  h.api.failDelete.add(second);
  h.clock.t += 50 * HOUR;
  await h.advance(1000);
  const third = h.preview.row(USER)!.message_id;
  assert.notEqual(third, second);
  const mark = h.api.of('editMessageWidgetData').find((c) => c.params.message_id === second);
  assert.equal(JSON.parse(mark!.params.chat_data).x, 1);
});

test('preview updates at local midnight and only edits on change', async () => {
  const h = harness(Date.UTC(2026, 10, 16, 22, 50)); // 23:50 Berlin
  await h.send('/start');
  await h.tasks.create(USER, { title: 'Tomorrow thing', date: '2026-11-17', time: null });
  await h.preview.flush();
  let s = state(h.api.last('editMessageWidgetData'));
  assert.equal(s.O.length, 1);
  const edits = h.api.of('editMessageWidgetData').length;
  await h.advance(60 * 1000);
  assert.equal(h.api.of('editMessageWidgetData').length, edits, 'no edit without change');
  await h.advance(10 * MIN); // past midnight
  s = state(h.api.last('editMessageWidgetData'));
  assert.equal(s.T.length, 1);
  assert.equal(s.O.length, 0);
  assert.equal(s.d, 'Tue, 17 Nov');
});

test('preview data always fits 1024 bytes', () => {
  const mk = (id: number, date: string, time: string | null): Task => ({ id, title: 'Очень длинное название задачи '.repeat(8), date, time, completed_at: null, deleted_at: null, created_at: 0, updated_at: 0, version: 1 });
  const active = [];
  for (let i = 1; i <= 40; i++) active.push(mk(i, i % 2 ? '2026-11-16' : '2026-11-2' + (i % 9), i % 3 ? '10:00' : null));
  const d = buildPreviewData(active, [], '2026-11-16', 600, 'a_very_long_bot_username_bot', 123456);
  assert.ok(bytes(JSON.stringify(d)) <= 1024);
  assert.ok(d.T.length + d.O.length >= 4);
});

test('optimistic concurrency rejects stale writes', async () => {
  const h = harness();
  const t = await h.tasks.create(USER, { title: 'X', date: '2026-11-16', time: null });
  await h.tasks.update(USER, t.id, t.version, { title: 'Y' });
  await assert.rejects(() => h.tasks.update(USER, t.id, t.version, { title: 'Z' }), /version conflict/);
  const cur = h.tasks.get(USER, t.id)!;
  const u = await h.tasks.update(USER, t.id, cur.version, { time: '15:00' });
  assert.equal(u.date, '2026-11-16', 'adding a time keeps the date');
  const v = await h.tasks.update(USER, t.id, u.version, { time: null });
  assert.equal(v.date, '2026-11-16', 'removing the time keeps the date');
});

test('time zone change re-arms reminders', async () => {
  const h = harness();
  const t = await h.tasks.create(USER, { title: 'X', date: '2026-11-16', time: '15:00' });
  assert.equal(h.reminders.row(t.id)!.next_fire_at, Date.UTC(2026, 10, 16, 14, 0));
  await h.send('/settings america/new_york');
  assert.equal(h.tasks.tz(USER), 'America/New_York');
  assert.equal(h.reminders.row(t.id)!.next_fire_at, Date.UTC(2026, 10, 16, 20, 0));
  await h.send('/settings Asia/Tokyo'); // 15:00 Tokyo has already passed → no reminder
  assert.equal(h.reminders.row(t.id), null);
});
