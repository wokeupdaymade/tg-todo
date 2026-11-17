// Mini App: Today | All Other Days, with History and add/edit sheets.
import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { compareTasks, isOverdue } from '../../src/tasks.ts';
import { localNow, relativeDateLabel, shortDateLabel, addDays } from '../../src/time.ts';
import { api, ApiError, type ApiTask, type Mutation, type ServerState } from './api.ts';
import { EditSheet, type SheetResult } from './EditSheet.tsx';
import { HistorySheet } from './HistorySheet.tsx';
import { Row } from './Row.tsx';
import { boot, haptic, initData, onForeground, startParam, wa } from './tg.ts';
import './styles.css';

const UNDO_MS = 5000;
type Tab = 'today' | 'other';
type Sheet = { kind: 'add' } | { kind: 'edit'; task: ApiTask; focusDate?: boolean } | { kind: 'history' } | null;
type Toast = { id: number; text: string; undo?: () => void } | null;

/** Tells the person exactly why the app can't load, so it can be fixed. */
function describeLoadError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Couldn\'t reach the server. Check that start.bat is running, then reopen the app.';
  if (e.status === 403) {
    return `Your Telegram account (id ${e.body.user_id ?? '?'}) isn't allowed. Put this id in ALLOWED_USER_IDS in .env and restart start.bat.`;
  }
  if (e.status === 401) {
    if (e.body.reason === 'missing' || !initData()) {
      return 'Telegram\'s login data didn\'t reach the app. This happens once after the tunnel\'s warning page. Close the app and open it again from the bot.';
    }
    if (e.body.reason === 'bad-signature') {
      return 'Telegram\'s login data doesn\'t match this bot. Open the app from the same bot whose token is in BOT_TOKEN.';
    }
    if (e.body.reason === 'expired') return 'This session is too old. Close the app and open it again from the bot.';
    return 'Telegram\'s login data was unreadable. Close the app and open it again from the bot.';
  }
  return 'Couldn\'t reach the server. Check that start.bat is running, then reopen the app.';
}

function App() {
  const [srv, setSrv] = useState<ServerState | null>(null);
  const [offset, setOffset] = useState(0);          // server clock − device clock
  const [, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>('today');
  const [held, setHeld] = useState<Map<number, ApiTask>>(new Map()); // completed, inside the undo window
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [overdueCollapsed, setOverdueCollapsed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const paneOther = useRef<HTMLDivElement>(null);
  const didScrollOther = useRef(false);
  const handledStart = useRef(false);
  const toastTimer = useRef<number>(0);

  const accept = useCallback((s: ServerState) => {
    setSrv(s);
    setOffset(s.now - Date.now());
    setLoadError(null);
  }, []);

  const refresh = useCallback(async () => {
    try { accept(await api.state()); } catch (e) {
      setLoadError(describeLoadError(e));
    }
  }, [accept]);

  useEffect(() => {
    boot();
    void refresh();
    onForeground(() => void refresh());
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // "Today" and "now" come from the server (its zone, its clock), advanced locally between fetches.
  const ln = srv ? localNow(Date.now() + offset, srv.tz) : null;
  const today = ln?.date ?? '';
  const nowMin = ln?.minutes ?? 0;
  useEffect(() => { if (srv && today && today !== srv.today) void refresh(); }, [today]);

  const showToast = (text: string, undo?: () => void) => {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ id, text, undo });
    toastTimer.current = window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), UNDO_MS);
  };

  const fail = async (e: unknown) => {
    haptic.warn();
    if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
      showToast('This task changed elsewhere — refreshed.');
      await refresh();
    } else showToast('Couldn\'t save. Check your connection and try again.');
  };

  const run = async (p: Promise<Mutation>): Promise<Mutation | null> => {
    try { const r = await p; accept(r.state); return r; } catch (e) { await fail(e); return null; }
  };

  // Actions ---------------------------------------------------------------------

  const complete = async (t: ApiTask) => {
    haptic.success();
    setHeld((m) => new Map(m).set(t.id, { ...t, completed_at: Date.now() }));
    const r = await run(api.action(t.id, 'complete', t.version));
    if (!r) { setHeld((m) => { const n = new Map(m); n.delete(t.id); return n; }); return; }
    setTimeout(() => setHeld((m) => { const n = new Map(m); n.delete(t.id); return n; }), UNDO_MS);
    showToast('Completed', async () => {
      setHeld((m) => { const n = new Map(m); n.delete(t.id); return n; });
      setToast(null);
      await run(api.action(t.id, 'uncomplete', r.task.version));
    });
  };

  const uncompleteHeld = async (t: ApiTask) => {
    setHeld((m) => { const n = new Map(m); n.delete(t.id); return n; });
    setToast(null);
    await run(api.action(t.id, 'uncomplete'));
  };

  const remove = async (t: ApiTask) => {
    haptic.tap();
    setSheet(null);
    const r = await run(api.action(t.id, 'delete', t.version));
    if (r) showToast('Deleted', async () => { setToast(null); await run(api.action(t.id, 'undelete', r.task.version)); });
  };

  const saveSheet = async (res: SheetResult) => {
    const s = sheet;
    setSheet(null);
    if (s?.kind === 'add') {
      const r = await run(api.create(res));
      if (r) { haptic.success(); setTab(r.task.date === r.state.today ? 'today' : 'other'); }
    } else if (s?.kind === 'edit') {
      const t = s.task;
      const patch: Partial<SheetResult> = {};
      if (res.title !== t.title) patch.title = res.title;
      if (res.date !== t.date) patch.date = res.date;
      if (res.time !== t.time) patch.time = res.time;
      if (Object.keys(patch).length) await run(api.update(t.id, t.version, patch));
    }
  };

  const restore = async (t: ApiTask) => {
    const r = await run(api.action(t.id, 'uncomplete', t.version));
    if (r) { haptic.success(); showToast(`Restored to ${relativeDateLabel(r.task.date, r.state.today)}`); }
    return !!r;
  };

  // Deep links from the preview widget: t<id>, today, other, overdue, all.
  useEffect(() => {
    if (!srv || handledStart.current) return;
    handledStart.current = true;
    const p = startParam();
    if (!p) return;
    if (p === 'other' || p === 'overdue') setTab('other');
    if (p === 'overdue') didScrollOther.current = true; // stay at the top, where Overdue is
    const m = /^t(\d+)$/.exec(p);
    if (m) {
      const t = srv.tasks.find((x) => x.id === Number(m[1]));
      if (t) { setTab(t.date === srv.today ? 'today' : 'other'); setSheet({ kind: 'edit', task: t }); }
    }
  }, [srv]);

  // Telegram's back button closes sheets.
  useEffect(() => {
    const bb = wa?.BackButton;
    if (!bb) return;
    const close = () => setSheet(null);
    if (sheet) { bb.show(); bb.onClick(close); } else bb.hide();
    return () => bb.offClick(close);
  }, [sheet]);

  // Lists ---------------------------------------------------------------------------

  const all = useMemo(() => {
    if (!srv) return [];
    const ids = new Set(srv.tasks.map((t) => t.id));
    return [...srv.tasks, ...[...held.values()].filter((t) => !ids.has(t.id))].sort(compareTasks);
  }, [srv, held]);

  const todays = all.filter((t) => t.date === today);
  const overdue = all.filter((t) => t.date < today);
  const future = all.filter((t) => t.date > today);
  const futureGroups: [string, ApiTask[]][] = [];
  for (const t of future) {
    const g = futureGroups[futureGroups.length - 1];
    if (g && g[0] === t.date) g[1].push(t); else futureGroups.push([t.date, [t]]);
  }

  // All Other Days opens scrolled to the first future date; Overdue sits above it.
  useLayoutEffect(() => {
    if (tab !== 'other' || didScrollOther.current || !srv) return;
    didScrollOther.current = true;
    const pane = paneOther.current, anchor = pane?.querySelector('#future-anchor') as HTMLElement | null;
    if (pane && anchor) pane.scrollTop = anchor.offsetTop - 8;
  }, [tab, srv]);

  const row = (t: ApiTask, meta: string) => {
    const done = held.has(t.id);
    return (
      <Row key={t.id} task={t} done={done} meta={meta} late={!done && isOverdue(t, today, nowMin)}
        open={openRow === t.id} onOpenChange={(o) => setOpenRow(o ? t.id : null)}
        onToggle={() => (done ? uncompleteHeld(t) : complete(t))}
        onEdit={() => !done && setSheet({ kind: 'edit', task: t })}
        onReschedule={() => setSheet({ kind: 'edit', task: t, focusDate: true })}
        onDelete={() => remove(t)} />
    );
  };

  if (!srv) {
    return <div class="app"><div class="empty center">{loadError ?? (initData() ? 'Loading…' : 'Open this app from the bot in Telegram.')}</div></div>;
  }

  const dateOnly = todays.filter((t) => !t.time);
  const timed = todays.filter((t) => t.time);

  return (
    <div class="app" onClick={() => openRow !== null && setOpenRow(null)}>
      <header class="nav">
        <button type="button" class="icon-btn" aria-label="Completed tasks" onClick={() => setSheet({ kind: 'history' })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </button>
        <div class="seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'today'} class={tab === 'today' ? 'on' : ''}
            onClick={() => { if (tab !== 'today') haptic.select(); setTab('today'); }}>Today</button>
          <button type="button" role="tab" aria-selected={tab === 'other'} class={tab === 'other' ? 'on' : ''}
            onClick={() => { if (tab !== 'other') haptic.select(); setTab('other'); }}>All Other Days</button>
        </div>
        <button type="button" class="icon-btn" aria-label="New task" onClick={() => setSheet({ kind: 'add' })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </header>

      <main class={`pane${tab === 'today' ? ' active' : ''}`} aria-hidden={tab !== 'today'}>
        <div class="day-title">{shortDateLabel(today)}</div>
        {todays.length === 0 && <div class="empty">Nothing for today.<br /><span class="muted">Tap + to add a task.</span></div>}
        {dateOnly.length > 0 && <>
          <div class="group-label">Without specific time</div>
          <div class="group">{dateOnly.map((t) => row(t, ''))}</div>
        </>}
        {timed.length > 0 && <>
          <div class="group-label">Scheduled</div>
          <div class="group">{timed.map((t) => row(t, t.time!))}</div>
        </>}
        <div class="pane-end" />
      </main>

      <main ref={paneOther} class={`pane${tab === 'other' ? ' active' : ''}`} aria-hidden={tab !== 'other'}>
        {overdue.length > 0 && <>
          <button type="button" class="group-label overdue-head" aria-expanded={!overdueCollapsed} onClick={() => setOverdueCollapsed((c) => !c)}>
            <span>Overdue <span class="late-count">{overdue.length}</span></span>
            <span class={`chev${overdueCollapsed ? '' : ' down'}`}>›</span>
          </button>
          {!overdueCollapsed && <div class="group">{overdue.map((t) => row(t, relativeDateLabel(t.date, today) + (t.time ? ` · ${t.time}` : '')))}</div>}
        </>}
        <div id="future-anchor" />
        {futureGroups.length === 0 && <div class="empty">No upcoming tasks.<br /><span class="muted">Tap + to plan something.</span></div>}
        {futureGroups.map(([date, items]) => (
          <section key={date}>
            <div class="group-label">{date === addDays(today, 1) ? `Tomorrow · ${shortDateLabel(date, today)}` : shortDateLabel(date, today)}</div>
            <div class="group">{items.map((t) => row(t, t.time ?? ''))}</div>
          </section>
        ))}
        <div class="pane-end tall" />
      </main>

      {toast && (
        <div class="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" class="link strong" onClick={toast.undo}>Undo</button>}
        </div>
      )}

      {(sheet?.kind === 'add' || sheet?.kind === 'edit') && (
        <EditSheet key={sheet.kind === 'edit' ? `e${sheet.task.id}` : 'add'} task={sheet.kind === 'edit' ? sheet.task : null} today={today}
          focusDate={sheet.kind === 'edit' ? sheet.focusDate : false}
          onCancel={() => setSheet(null)} onSave={saveSheet}
          onComplete={sheet.kind === 'edit' ? () => { const t = sheet.task; setSheet(null); void complete(t); } : undefined}
          onDelete={sheet.kind === 'edit' ? () => remove(sheet.task) : undefined} />
      )}
      {sheet?.kind === 'history' && <HistorySheet today={today} tz={srv.tz} onClose={() => setSheet(null)} onRestore={restore} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
