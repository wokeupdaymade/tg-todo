// Completed tasks, newest first; tap to restore to the original date/time.
import { useEffect, useRef, useState } from 'preact/hooks';
import { relativeDateLabel } from '../../src/time.ts';
import { api, type ApiTask } from './api.ts';

export function HistorySheet(props: { today: string; tz: string; onClose: () => void; onRestore: (t: ApiTask) => Promise<boolean> }) {
  const [items, setItems] = useState<ApiTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const load = async (c: string | null) => {
    if (loading) return;
    setLoading(true);
    try {
      const r = await api.history(c);
      setItems((prev) => (c ? [...prev, ...r.tasks] : r.tasks));
      setCursor(r.cursor);
      setDone(!r.cursor);
      setFailed(false);
    } catch { setFailed(true); }
    setLoading(false);
  };
  useEffect(() => { void load(null); }, []);

  const onScroll = () => {
    const el = body.current;
    if (el && !done && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) void load(cursor);
  };

  const completedLabel = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: props.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

  return (
    <div class="sheet-wrap" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="sheet tall" role="dialog" aria-label="Completed tasks">
        <div class="sheet-bar">
          <span />
          <span class="sheet-title">Completed</span>
          <button type="button" class="link strong" onClick={props.onClose}>Done</button>
        </div>
        <div class="sheet-body" ref={body} onScroll={onScroll}>
          {items.length === 0 && !loading && !failed && <div class="empty">No completed tasks yet.</div>}
          {failed && <div class="empty">Couldn't load history. <button type="button" class="link" onClick={() => load(cursor)}>Retry</button></div>}
          {items.length > 0 && (
            <div class="group">
              {items.map((t) => (
                <button type="button" key={t.id} class="cell cell-btn hist" onClick={async () => {
                  if (await props.onRestore(t)) setItems((prev) => prev.filter((x) => x.id !== t.id));
                }}>
                  <span class="hist-title">{t.title}</span>
                  <span class="hist-meta">
                    {relativeDateLabel(t.date, props.today)}{t.time ? ` · ${t.time}` : ''} — done {completedLabel(t.completed_at!)}
                  </span>
                  <span class="hist-restore">Restore</span>
                </button>
              ))}
            </div>
          )}
          {loading && <div class="empty">Loading…</div>}
        </div>
      </div>
    </div>
  );
}
