// iOS-style month calendar for picking dates.
import { useEffect, useState } from 'preact/hooks';
import { MONTHS, isValidDate, pad2, ymd } from '../../src/time.ts';
import { haptic } from './tg.ts';

export function Calendar(props: { value: string | null; today: string; onPick: (d: string) => void; allowPast?: boolean }) {
  const base = (props.value || props.today).split('-').map(Number);
  const [ym, setYm] = useState<[number, number]>([base[0], base[1] - 1]);
  // Follow the selected date when it changes from outside (e.g. typed).
  useEffect(() => {
    if (props.value) { const [vy, vm] = props.value.split('-').map(Number); setYm([vy, vm - 1]); }
  }, [props.value]);
  const [y, m] = ym;
  const first = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const shift = (d: number) => {
    const t = m + d;
    setYm([y + Math.floor(t / 12), ((t % 12) + 12) % 12]);
    haptic.select();
  };
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(<span key={`e${i}`} />);
  for (let d = 1; d <= days; d++) {
    if (!isValidDate(y, m + 1, d)) continue;
    const key = ymd(y, m + 1, d);
    const past = key < props.today && !props.allowPast;
    const cls = ['cal-day', key === props.today ? 'is-today' : '', key === props.value ? 'is-sel' : '', past ? 'is-past' : ''].join(' ');
    cells.push(
      <button key={key} type="button" class={cls} disabled={past} aria-label={key} aria-pressed={key === props.value}
        onClick={() => { haptic.select(); props.onPick(key); }}>{d}</button>,
    );
  }
  return (
    <div class="cal">
      <div class="cal-head">
        <span class="cal-title">{MONTHS[m]} {y}</span>
        <span class="cal-nav">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
          <button type="button" aria-label="Next month" onClick={() => shift(1)}>›</button>
        </span>
      </div>
      <div class="cal-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((c, i) => <span key={`w${i}`} class="cal-wd">{c}</span>)}
        {cells}
      </div>
    </div>
  );
}

export const fmtMonthDay = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
export const hhmm = (h: number, m: number) => `${pad2(h)}:${pad2(m)}`;
