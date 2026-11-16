import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, USER } from './helpers.ts';
import { signInitData, verifyInitData } from '../src/http/auth.ts';
import { handleApi } from '../src/http/server.ts';

const TOKEN = '123:abc';
const init = (id: number, authDate: number) => signInitData({ auth_date: String(authDate), user: JSON.stringify({ id, first_name: 'U' }), start_param: 't5', query_id: 'AA' }, TOKEN);

test('initData: valid, tampered, expired', () => {
  const now = Date.UTC(2026, 10, 16, 9);
  const good = init(USER, now / 1000 - 60);
  const v = verifyInitData(good, TOKEN, now);
  assert.equal(v?.user.id, USER);
  assert.equal(v?.startParam, 't5');
  assert.equal(verifyInitData(good.replace('4242', '4243'), TOKEN, now), null);
  assert.equal(verifyInitData(good, '123:other', now), null);
  assert.equal(verifyInitData(init(USER, now / 1000 - 25 * 3600), TOKEN, now), null);
  assert.equal(verifyInitData('', TOKEN, now), null);
});

test('API: auth, CRUD, conflicts, history', async () => {
  const h = harness();
  const deps = { ctx: h.ctx, tasks: h.tasks, botToken: TOKEN, allowed: new Set([USER]) };
  const auth = `tma ${init(USER, h.clock.t / 1000)}`;
  const call = (method: string, path: string, body?: unknown, a = auth) =>
    handleApi(deps, method, path, new URLSearchParams(path.split('?')[1] || ''), a, async () => (body ?? {}) as Record<string, unknown>)
      .catch((e) => ({ status: e.status ?? (e.constructor.name === 'ConflictError' ? 409 : e.constructor.name === 'ValidationError' ? 400 : 500), body: e.body ?? e.message }));

  assert.equal((await call('GET', '/api/state', undefined, 'tma nope')).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, `tma ${init(777, h.clock.t / 1000)}`)).status, 403);

  const st = await call('GET', '/api/state');
  assert.equal(st.status, 200);
  assert.equal((st.body as any).today, '2026-11-16');
  assert.equal((st.body as any).tz, 'Europe/Berlin');

  const c = await call('POST', '/api/tasks', { title: '  Plan trip ', date: '2026-11-20', time: null });
  assert.equal(c.status, 201);
  const task = (c.body as any).task;
  assert.equal(task.title, 'Plan trip');
  assert.equal((c.body as any).state.tasks.length, 1);

  assert.equal((await call('POST', '/api/tasks', { title: 'x', date: '2026-02-30', time: null })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', date: '2026-11-20', time: '25:00' })).status, 400);

  const u = await call('PATCH', `/api/tasks/${task.id}`, { version: task.version, time: '10:00' });
  assert.equal(u.status, 200);
  assert.equal((u.body as any).task.time, '10:00');
  assert.equal((await call('PATCH', `/api/tasks/${task.id}`, { version: task.version, title: 'stale' })).status, 409);

  const done = await call('POST', `/api/tasks/${task.id}/complete`, { version: (u.body as any).task.version });
  assert.equal(done.status, 200);
  assert.equal((done.body as any).state.tasks.length, 0);
  const hist = await call('GET', '/api/history');
  assert.equal((hist.body as any).tasks[0].id, task.id);
  const restored = await call('POST', `/api/tasks/${task.id}/uncomplete`, {});
  assert.equal((restored.body as any).task.date, '2026-11-20', 'restored to its original date');
  const del = await call('POST', `/api/tasks/${task.id}/delete`, {});
  assert.equal((del.body as any).state.tasks.length, 0);
  const und = await call('POST', `/api/tasks/${task.id}/undelete`, {});
  assert.equal((und.body as any).state.tasks.length, 1);
});
