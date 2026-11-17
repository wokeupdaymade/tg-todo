// Inline-keyboard fallback, used while Telegram refuses widgets (INPUT_MEDIA_WIDGET_NOT_ALLOWED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, USER, type Call } from './helpers.ts';
import { HOUR, MIN } from '../src/services/context.ts';

const blocked = (widgets: 'auto' | 'off' = 'auto') => { const h = harness(undefined, undefined, widgets); h.api.blockWidgets = true; return h; };
const kb = (c: Call) => c.params.reply_markup.inline_keyboard as any[][];
const labels = (c: Call) => kb(c).flat().map((b: any) => b.text);
const btn = (c: Call, text: string | RegExp) => kb(c).flat().find((b: any) => (typeof text === 'string' ? b.text === text : text.test(b.text)))!;
const lastReminder = (h: ReturnType<typeof harness>) => [...h.api.calls].reverse().find((c) => c.method === 'sendMessage' && /^⏰/.test(c.params.text))!;

/** Every keyboard Telegram would receive must be valid: data ≤ 64 bytes, non-blank labels. */
function checkKeyboards(h: ReturnType<typeof harness>) {
  for (const c of h.api.calls) {
    const rows = c.params?.reply_markup?.inline_keyboard;
    if (!rows) continue;
    for (const b of rows.flat()) {
      assert.ok(b.text.trim().length > 0, `blank button label in ${c.method}`);
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  }
}

test('refused widget → preview falls back to a text message with buttons', async () => {
  const h = blocked();
  await h.send('/start');
  assert.ok(h.api.of('sendWidget!refused').length >= 1);
  const p = h.api.last('sendMessage');
  assert.match(p.params.text, /Nothing planned/);
  assert.equal(p.params.parse_mode, 'HTML');
  assert.equal(p.params.disable_notification, true);
  assert.deepEqual(btn(p, '📱 Open App').web_app, { url: 'https://x.test/' });
  assert.equal(h.preview.row(USER)!.html_hash, 'text-v1');
  assert.equal(h.ui.forPreview(), 'text');
  // From now on no more widget attempts (until the 12 h re-check).
  const refused = h.api.of('sendWidget!refused').length;
  await h.tasks.create(USER, { title: 'Dentist <b>', date: '2026-11-16', time: '09:00' });
  await h.preview.flush();
  assert.equal(h.api.of('sendWidget!refused').length, refused);
  const e = h.api.last('editMessageText');
  assert.match(e.params.text, /Dentist &lt;b&gt; — ❗09:00/, 'escaped, marked late');
  checkKeyboards(h);
});

test('fallback creation flow: buttons for date, hour and minute; cleans up', async () => {
  const h = blocked();
  await h.send('/start');
  const src = await h.send('Buy milk');
  const m = h.api.last('sendMessage');
  assert.match(m.params.text, /Buy milk/);
  assert.deepEqual(labels(m), ['Today', 'Tomorrow', 'Other Date…', 'Cancel']);
  const id = m.result.message_id;
  const f = h.flows.openFlow(USER)!;
  assert.equal(f.ui, 'text');

  assert.equal(await h.tap(id, btn(m, 'Tomorrow').callback_data), '');
  let v = h.api.last('editMessageText');
  assert.match(v.params.text, /Tue, 17 Nov — what time/);
  assert.deepEqual(labels(v), ['No Specific Time', 'Select Time…', '‹ Back', 'Cancel']);
  assert.equal(h.api.calls.filter((c) => c.params?.reply_markup?.keyboard).length, 0, 'no reply keyboard in fallback mode');

  await h.tap(id, btn(v, 'Select Time…').callback_data);
  v = h.api.last('editMessageText');
  assert.equal(kb(v).length, 7, '6 rows of 4 hours + Back');
  await h.tap(id, btn(v, '14').callback_data);
  v = h.api.last('editMessageText');
  assert.equal(labels(v)[7], '14:35');
  // A stale revision is refused with a toast.
  assert.match(await h.tap(id, `ft.${f.id}.1.1435`), /Updated/);
  await h.tap(id, btn(v, '14:35').callback_data);

  const [t] = h.tasks.listActive(USER);
  assert.deepEqual([t.title, t.date, t.time], ['Buy milk', '2026-11-17', '14:35']);
  const deleted = h.api.of('deleteMessages').flatMap((c) => c.params.message_ids);
  assert.ok(deleted.includes(src) && deleted.includes(id));
  assert.equal(h.api.calls.filter((c) => c.params?.reply_markup?.remove_keyboard).length, 0, 'nothing to remove');
  assert.equal(h.api.live.size, 1, 'only the preview remains');
  checkKeyboards(h);
});

test('fallback calendar: month navigation, past days inert, pick a day', async () => {
  const h = blocked();
  await h.send('Trip');
  const m = h.api.last('sendMessage');
  const id = m.result.message_id;
  await h.tap(id, btn(m, 'Other Date…').callback_data);
  let c = h.api.last('editMessageText');
  assert.equal(kb(c)[0][1].text, 'November 2026');
  assert.equal(kb(c)[0][0].callback_data, 'nn.1', 'cannot go before the current month');
  assert.equal(btn(c, '•16').callback_data.split('.')[0], 'fd', 'today is marked and selectable');
  assert.equal(labels(c).filter((l) => l === '·').length, 15, 'Nov 1–15 are past');
  assert.equal(await h.tap(id, 'nn.1'), '');
  await h.tap(id, btn(c, '›').callback_data);
  c = h.api.last('editMessageText');
  assert.equal(kb(c)[0][1].text, 'December 2026');
  await h.tap(id, btn(c, '24').callback_data);
  assert.equal(h.flows.openFlow(USER)!.date, '2026-12-24');
  // Typed input still works: the time.
  await h.send('9.45');
  assert.equal(h.tasks.listActive(USER)[0].time, '09:45');
  checkKeyboards(h);
});

test('fallback: typed "Other Date" opens the calendar; Back and Cancel', async () => {
  const h = blocked();
  await h.send('Thing');
  const id = h.api.last('sendMessage').result.message_id;
  await h.send('Other Date');
  assert.equal(kb(h.api.last('editMessageText'))[0][1].text, 'November 2026');
  await h.send('Today');
  let v = h.api.last('editMessageText');
  await h.tap(id, btn(v, '‹ Back').callback_data);
  v = h.api.last('editMessageText');
  assert.deepEqual(labels(v), ['Today', 'Tomorrow', 'Other Date…', 'Cancel']);
  await h.tap(id, btn(v, 'Cancel').callback_data);
  assert.equal(h.flows.openFlow(USER), null);
  assert.equal(h.tasks.listActive(USER).length, 0);
});

test('fallback preview: ✓ completes with Undo, then hides; Open App follows the URL', async () => {
  const h = blocked();
  await h.send('/start');
  const pid = h.preview.row(USER)!.message_id;
  const a = await h.tasks.create(USER, { title: 'Water plants', date: '2026-11-16', time: null });
  await h.tasks.create(USER, { title: 'Pay rent', date: '2026-11-17', time: null });
  await h.preview.flush();
  let e = h.api.last('editMessageText');
  assert.match(e.params.text, /<b>Other days<\/b>\n▫️ Pay rent — Tomorrow/);
  assert.equal(await h.tap(pid, btn(e, '✓ Water plants').callback_data), '');
  e = h.api.last('editMessageText');
  assert.match(e.params.text, /☑️ <s>Water plants<\/s>/);
  assert.ok(btn(e, /Undo: Water plants/));
  await h.advance(6000);
  e = h.api.last('editMessageText');
  assert.doesNotMatch(e.params.text, /Water plants/);
  assert.ok(h.tasks.get(USER, a.id)!.completed_at);
  // Taps on a message that isn't the current preview are refused.
  assert.match(await h.tap(pid + 500, `pc.${a.id}`), /Outdated/);
  // New tunnel address → the Open App button is updated in place.
  h.ctx.cfg.publicUrl = 'https://new.test';
  await h.advance(1000);
  assert.deepEqual(btn(h.api.last('editMessageText'), '📱 Open App').web_app, { url: 'https://new.test/' });
  assert.equal(h.preview.row(USER)!.message_id, pid, 'edited, not re-sent');
});

test('fallback reminders: text message with Done / Snooze / Dismiss', async () => {
  const h = blocked();
  const t = await h.tasks.create(USER, { title: 'Pills', date: '2026-11-16', time: '10:30' });
  await h.advance(30 * MIN);
  const r = lastReminder(h);
  assert.equal(r.method, 'sendMessage');
  assert.match(r.params.text, /⏰ <b>10:30<\/b>\nPills/);
  assert.equal(r.params.disable_notification, undefined, 'reminders make a sound');
  assert.deepEqual(labels(r), ['✓ Done', 'Snooze 15 min', 'Dismiss']);
  await h.advance(5 * MIN);
  const r2 = lastReminder(h);
  assert.ok(!h.api.live.has(r.result.message_id), 'repeat replaced the previous one');
  assert.equal(await h.tap(r2.result.message_id, btn(r2, '✓ Done').callback_data), '');
  assert.ok(h.tasks.get(USER, t.id)!.completed_at);
  assert.ok(!h.api.live.has(r2.result.message_id));
  checkKeyboards(h);
});

test('re-checks widgets after 12 h and switches back when Telegram allows them again', async () => {
  const h = blocked();
  await h.send('/start');
  const textPreview = h.preview.row(USER)!.message_id;
  h.api.blockWidgets = false;
  await h.send('Task A');                 // < 12 h: still text, no probe
  assert.equal(h.flows.openFlow(USER)!.ui, 'text');
  await h.send('/cancel');
  h.clock.t += 12 * HOUR + MIN;
  await h.send('Task B');                 // probe: widget accepted
  assert.equal(h.flows.openFlow(USER)!.ui, 'widget');
  await h.send('/cancel');
  await h.advance(1000);                  // preview follows: re-sent as a widget, text copy deleted
  const row = h.preview.row(USER)!;
  assert.notEqual(row.html_hash, 'text-v1');
  assert.ok(!h.api.live.has(textPreview));
});

test('WIDGETS=off never tries widgets', async () => {
  const h = harness(undefined, undefined, 'off');
  await h.send('/start');
  await h.send('Thing');
  assert.equal(h.api.of('sendWidget').length + h.api.of('sendWidget!refused').length, 0);
  assert.equal(h.flows.openFlow(USER)!.ui, 'text');
});
