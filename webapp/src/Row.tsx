// A task row: circular checkbox, title, secondary time/date. Tap opens the edit
// sheet; a horizontal swipe (starting ≥20 px from the left edge, so the system
// back gesture keeps working) reveals Reschedule / Delete.
import { useRef, useState } from 'preact/hooks';
import type { ApiTask } from './api.ts';
import { haptic } from './tg.ts';

const ACTIONS_W = 156;

export function Row(props: {
  task: ApiTask;
  done: boolean;            // completed, inside its undo window
  meta: string;             // secondary text
  late: boolean;
  open: boolean;            // swipe actions revealed
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
  onEdit: () => void;
  onReschedule: () => void;
  onDelete: () => void;
}) {
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; base: number; active: boolean; decided: boolean } | null>(null);
  const offset = drag.current?.active ? dx : props.open ? -ACTIONS_W : 0;

  const down = (e: PointerEvent) => {
    if (e.clientX < 20 || props.done) return;
    drag.current = { x: e.clientX, y: e.clientY, base: props.open ? -ACTIONS_W : 0, active: false, decided: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x, my = e.clientY - d.y;
    if (!d.decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      d.decided = true;
      d.active = Math.abs(mx) > Math.abs(my) * 1.2;
      if (!d.active) { drag.current = null; return; }
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDx(Math.max(-ACTIONS_W - 30, Math.min(0, d.base + mx)));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    const open = dx < -ACTIONS_W / 2;
    if (open !== props.open) haptic.select();
    props.onOpenChange(open);
    setDx(0);
  };

  return (
    <div class={`row-wrap${props.open ? ' is-open' : ''}`}>
      <div class="row-actions" aria-hidden={!props.open}>
        <button type="button" class="act act-move" onClick={() => { props.onOpenChange(false); props.onReschedule(); }}>Reschedule</button>
        <button type="button" class="act act-del" onClick={() => { props.onOpenChange(false); props.onDelete(); }}>Delete</button>
      </div>
      <div class={`row${props.done ? ' is-done' : ''}${drag.current?.active ? ' dragging' : ''}`} style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={down as never} onPointerMove={move as never} onPointerUp={up} onPointerCancel={up}>
        <button type="button" class={`check${props.done ? ' on' : ''}`} aria-label={props.done ? 'Mark as not done' : 'Mark as done'}
          onClick={(e) => { e.stopPropagation(); props.onToggle(); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.5 3.5 7.5-8" /></svg>
        </button>
        <button type="button" class="row-main" onClick={() => (props.open ? props.onOpenChange(false) : props.onEdit())}>
          <span class="row-title">{props.task.title}</span>
          {props.meta && <span class={`row-meta${props.late ? ' late' : ''}`}>{props.meta}</span>}
        </button>
      </div>
    </div>
  );
}
