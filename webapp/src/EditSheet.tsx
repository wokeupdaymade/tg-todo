// Add / edit sheet: title → date (Today / Tomorrow / Other Date + calendar) → time
// (No Specific Time or a time). Dates and times can also be typed, using the
// same parser as the chat.
import { useEffect, useRef, useState } from 'preact/hooks';
import { parseDate, parseTime } from '../../src/parse.ts';
import { addDays, relativeDateLabel } from '../../src/time.ts';
import type { ApiTask } from './api.ts';
import { Calendar } from './Calendar.tsx';
import { haptic } from './tg.ts';

export type SheetResult = { title: string; date: string; time: string | null };

export function EditSheet(props: {
  task: ApiTask | null;          // null = new task
  today: string;
  focusDate?: boolean;
  onCancel: () => void;
  onSave: (r: SheetResult) => void;
  onComplete?: () => void;
  onDelete?: () => void;
}) {
  const t = props.task;
  const [title, setTitle] = useState(t?.title ?? '');
  const [date, setDate] = useState<string>(t?.date ?? props.today);
  const [time, setTime] = useState<string | null>(t?.time ?? null);
  const [timed, setTimed] = useState<boolean>(!!t?.time);
  const tomorrow = addDays(props.today, 1);
  const [showCal, setShowCal] = useState<boolean>(!!props.focusDate || (!!t && t.date !== props.today && t.date !== tomorrow));
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!t && titleRef.current) setTimeout(() => titleRef.current?.focus(), 250);
  }, []);
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);

  const typedDate = dateText.trim() ? parseDate(dateText, props.today) : null;
  const typedTime = timeText.trim() ? parseTime(timeText) : null;
  const effTime = timed ? time : null;
  const canSave = title.trim().length > 0 && !!date && (!timed || !!time);
  const chip = date === props.today ? 'today' : date === tomorrow ? 'tomorrow' : 'other';

  const save = () => { if (canSave) props.onSave({ title: title.trim(), date, time: effTime }); };

  return (
    <div class="sheet-wrap" onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div class="sheet" role="dialog" aria-label={t ? 'Edit task' : 'New task'}>
        <div class="sheet-bar">
          <button type="button" class="link" onClick={props.onCancel}>Cancel</button>
          <span class="sheet-title">{t ? 'Edit Task' : 'New Task'}</span>
          <button type="button" class="link strong" disabled={!canSave} onClick={save}>{t ? 'Done' : 'Add'}</button>
        </div>
        <div class="sheet-body">
          <div class="group">
            <textarea ref={titleRef} class="title-input" rows={1} maxLength={256} placeholder="Title" value={title}
              onInput={(e) => setTitle((e.target as HTMLTextAreaElement).value.replace(/\n/g, ' '))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }} />
          </div>

          <div class="group-label">Date</div>
          <div class="group">
            <div class="cell">
              <div class="seg seg-full">
                <button type="button" class={chip === 'today' && !showCal ? 'on' : ''} onClick={() => { setDate(props.today); setShowCal(false); haptic.select(); }}>Today</button>
                <button type="button" class={chip === 'tomorrow' && !showCal ? 'on' : ''} onClick={() => { setDate(tomorrow); setShowCal(false); haptic.select(); }}>Tomorrow</button>
                <button type="button" class={chip === 'other' || showCal ? 'on' : ''} onClick={() => { setShowCal(true); haptic.select(); }}>Other Date</button>
              </div>
            </div>
            {showCal && <div class="cell"><Calendar value={date} today={props.today} onPick={setDate} allowPast={!!t && t.date < props.today} /></div>}
            <div class="cell row-between">
              <span class="muted">{relativeDateLabel(date, props.today)}</span>
              <input class="inline-input" type="text" inputMode="text" placeholder="Type a date, e.g. 11.12" value={dateText}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  setDateText(v);
                  const d = parseDate(v, props.today);
                  if (d) { setDate(d); }
                }} />
            </div>
            {dateText.trim() && !typedDate && <div class="cell hint-bad">Couldn't read that date. Try 11.12, 11 Dec or December 11.</div>}
          </div>

          <div class="group-label">Time</div>
          <div class="group">
            <div class="cell">
              <div class="seg seg-full">
                <button type="button" class={!timed ? 'on' : ''} onClick={() => { setTimed(false); haptic.select(); }}>No Specific Time</button>
                <button type="button" class={timed ? 'on' : ''} onClick={() => { setTimed(true); if (!time) setTime('09:00'); haptic.select(); }}>Set Time</button>
              </div>
            </div>
            {timed && (
              <div class="cell row-between">
                <input class="time-input" type="time" step={300} value={time ?? ''} onInput={(e) => setTime((e.target as HTMLInputElement).value || null)} />
                <input class="inline-input" type="text" inputMode="numeric" placeholder="or type, e.g. 14:30" value={timeText}
                  onInput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    setTimeText(v);
                    const tt = parseTime(v);
                    if (tt) setTime(tt);
                  }} />
              </div>
            )}
            {timed && timeText.trim() && !typedTime && <div class="cell hint-bad">Couldn't read that time. Try 14:30, 9.45 or 9:45 PM.</div>}
          </div>

          {t && (
            <div class="group">
              {props.onComplete && <button type="button" class="cell cell-btn" onClick={props.onComplete}>Mark as Done</button>}
              {props.onDelete && <button type="button" class="cell cell-btn danger" onClick={props.onDelete}>Delete Task</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
