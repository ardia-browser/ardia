import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageMeta } from "../../../shared/model";
import {
  TITLE,
  addDays,
  addMonths,
  dateValue,
  daysBetween,
  isEditable,
  isVisible,
  parseDateString,
  startOfDay,
  startOfWeek,
  toDateString,
  viewProperties,
  type DateValue,
  type Property,
} from "../../../shared/database";
import { CellView, RowIcon, isEmptyCell } from "../cells";
import { Icon } from "../icons";
import { registerCss } from "../styles";
import { DragGhost, Menu, MenuItem, Popover, startDrag, usePopover } from "../ui";
import type { ViewProps } from "./types";
import { EASE, MOTION, reducedMotion, useFlip } from "../../ui/motion";

registerCss(
  "calendar",
  `
.db-cal { display: flex; flex-direction: column; min-width: 0; }
.db-cal-head { display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 2px; }
.db-cal-title { font-size: var(--n-t-body, 13px); font-weight: var(--n-w-semibold, 600); flex: 1; min-width: 0; }
.db-cal-nodate-btn { color: var(--n-text-2); }
.db-cal-grid { display: grid; border-top: 0.5px solid var(--n-divider); border-left: 0.5px solid var(--n-divider); }
.db-cal-wd { height: 28px; line-height: 28px; text-align: center; font-size: 12px; color: var(--n-text-2); border-right: 0.5px solid var(--n-divider); border-bottom: 0.5px solid var(--n-divider); }
.db-cal-cell { position: relative; min-height: 116px; padding: 4px 4px 6px; border-right: 0.5px solid var(--n-divider); border-bottom: 0.5px solid var(--n-divider); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.db-cal-cell.is-out { background: var(--n-raised); }
.db-cal-cell.is-out .db-cal-num { color: var(--n-text-3); }
.db-cal-cell.is-drop { background: color-mix(in srgb, var(--n-form-accent) 12%, transparent); box-shadow: inset 0 0 0 1.5px var(--n-form-accent); }
.db-cal-cell-top { display: flex; align-items: center; justify-content: flex-end; height: 22px; gap: 2px; }
.db-cal-add { opacity: 0; width: 22px; height: 22px; }
.db-cal-cell:hover .db-cal-add { opacity: 1; }
.db-cal-num { font-size: 13px; min-width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 11px; font-variant-numeric: tabular-nums; color: var(--n-text-2); }
.db-cal-num.is-today { background: var(--n-red); color: #fff; font-weight: 600; }
.db-cal-item { display: flex; flex-direction: column; gap: 2px; padding: 3px 6px; border-radius: var(--n-r-control, 4px); background: var(--n-control); box-shadow: inset 0 0 0 1px var(--n-control-border); font-size: var(--n-t-small, 12px); min-width: 0; cursor: default; user-select: none; }
.db-cal-item:hover { background: var(--n-control-hover); }
.db-cal-item.is-dragging { opacity: .35; }
.db-cal-item.is-cont { border-top-left-radius: 0; border-bottom-left-radius: 0; }
.db-cal-item.is-more { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.db-cal-item-title { display: flex; align-items: center; gap: 4px; font-weight: 500; min-width: 0; }
.db-cal-item-title > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-cal-item-prop { min-width: 0; overflow: hidden; font-size: 12px; color: var(--n-text-2); }
.db-cal-item-prop .db-tag { height: 18px; line-height: 18px; font-size: 12px; }
.db-cal-hint { padding: 48px 16px; text-align: center; color: var(--n-text-2); font-size: var(--n-t-body, 13px); }
.db-cal-ghost { padding: 3px 6px; font-size: 12.5px; font-weight: 500; }
`,
);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftDate(value: DateValue, days: number): DateValue {
  const s = parseDateString(value.start)!;
  const e = parseDateString(value.end);
  return { start: toDateString(addDays(s.ms, days), s.time), ...(e ? { end: toDateString(addDays(e.ms, days), e.time) } : {}) };
}

function CalItem({ p, row, cont, more, cardProps, dragging, onDown }: { p: ViewProps; row: PageMeta; cont: boolean; more: boolean; cardProps: Property[]; dragging: boolean; onDown: (e: React.PointerEvent) => void }) {
  const { m } = p;
  return (
    <div className={`db-cal-item ${cont ? "is-cont" : ""} ${more ? "is-more" : ""} ${dragging ? "is-dragging" : ""}`} data-testid="db-cal-item" data-row={row.id} onPointerDown={onDown} onContextMenu={(e) => {
      e.preventDefault();
      p.openRowMenu(row, { x: e.clientX, y: e.clientY });
    }}>
      <span className="db-cal-item-title">
        <RowIcon m={m} row={row} size={13} />
        <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
      </span>
      {!cont &&
        cardProps.map((prop) =>
          isEmptyCell(m, row, prop) ? null : (
            <span key={prop.id} className="db-cal-item-prop">
              <CellView m={m} row={row} prop={prop} card />
            </span>
          ),
        )}
    </div>
  );
}

export function CalendarView(p: ViewProps) {
  const { m, view, result, actions } = p;
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  });
  const [drag, setDrag] = useState<{ row: string; x: number; y: number; day: string | null; title: string } | null>(null);
  const noDate = usePopover();
  const prop = m.schema.find((x) => x.id === view.dateProp);
  const editable = !!prop && isEditable(prop.type) && p.editable;
  const cardProps = useMemo(() => viewProperties(view, m.schema).filter((x) => x.id !== TITLE && x.id !== view.dateProp && isVisible(view, x)), [view, m.schema]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastMonth = useRef(month);
  const flipMonth = useRef(month);
  useFlip(gridRef, ".db-cal-item[data-row]:not(.is-cont)", "data-row", [result.rows, month, view.showWeekends], { enter: true, skip: flipMonth.current !== month });
  useLayoutEffect(() => {
    flipMonth.current = month;
  }, [month]);
  useEffect(() => {
    const el = gridRef.current;
    const dir = month > lastMonth.current ? 1 : month < lastMonth.current ? -1 : 0;
    lastMonth.current = month;
    if (!el || !dir) return;
    const shift = reducedMotion() ? 0 : dir * 12;
    el.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: "none" }], { duration: MOTION.slow, easing: EASE.soft });
  }, [month]);
  const first = new Date(month);
  const gridStart = startOfWeek(month);
  const lastOfMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getTime();
  const weeks = Math.ceil((daysBetween(gridStart, lastOfMonth) + 1) / 7);
  const gridEnd = addDays(gridStart, weeks * 7);
  const cols = view.showWeekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  const today = toDateString(Date.now());

  const { byDay, undated } = useMemo(() => {
    const map = new Map<string, { row: PageMeta; cont: boolean; more: boolean }[]>();
    const none: PageMeta[] = [];
    if (!prop) return { byDay: map, undated: none };
    for (const row of result.rows) {
      const d = dateValue(row, prop);
      const s = d ? parseDateString(d.start) : null;
      if (!s) {
        none.push(row);
        continue;
      }
      const e = parseDateString(d!.end);
      const startDay = startOfDay(s.ms);
      const endDay = e ? startOfDay(Math.max(e.ms, s.ms)) : startDay;
      if (endDay < gridStart || startDay >= gridEnd) continue;
      const from = Math.max(startDay, gridStart);
      const span = Math.min(daysBetween(from, endDay), 62);
      for (let i = 0; i <= span; i++) {
        const day = addDays(from, i);
        if (day >= gridEnd) break;
        const key = toDateString(day);
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        list.push({ row, cont: day !== startDay && new Date(day).getDay() !== 0, more: day !== endDay && new Date(day).getDay() !== 6 });
      }
    }
    return { byDay: map, undated: none };
  }, [result.rows, prop, gridStart, gridEnd]);

  const beginDrag = (e: React.PointerEvent, row: PageMeta) => {
    if (e.button !== 0) return;
    const origin = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day ?? null;
    startDrag(e, {
      onStart: () => {
        if (!editable) return;
        setDrag({ row: row.id, x: e.clientX, y: e.clientY, day: origin, title: row.title || "Untitled" });
      },
      onMove: (ev) => {
        if (!editable) return;
        const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-testid=db-cal-day]");
        setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY, day: hit?.dataset.day ?? null } : d));
      },
      onEnd: (ev, moved) => {
        if (!moved) {
          p.openRow(row.id);
          return;
        }
        setDrag(null);
        if (!editable || !prop || !origin) return;
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-testid=db-cal-day]")?.dataset.day;
        if (!target || target === origin) return;
        const current = dateValue(m.store.pages.get(row.id) ?? row, prop);
        if (!current) return;
        const delta = daysBetween(parseDateString(origin)!.ms, parseDateString(target)!.ms);
        actions.setValue(row.id, prop, shiftDate(current, delta));
      },
    });
  };

  if (!prop)
    return (
      <div className="db-cal" data-testid="db-calendar">
        <div className="db-cal-hint">Pick a date property in Layout</div>
      </div>
    );

  return (
    <div className="db-cal" data-testid="db-calendar">
      <div className="db-cal-head">
        <span className="db-cal-title">{first.toLocaleString("en-US", { month: "long", year: "numeric" })}</span>
        <button type="button" className="db-btn db-cal-nodate-btn" data-testid="db-cal-nodate" onClick={(e) => noDate.toggle(e.currentTarget)} data-db-anchor-open="">
          No date ({undated.length})
        </button>
        <button type="button" className="db-icon-btn" data-testid="db-cal-prev" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <button type="button" className="db-btn" data-testid="db-cal-today" onClick={() => {
          const d = new Date();
          setMonth(new Date(d.getFullYear(), d.getMonth(), 1).getTime());
        }}>
          Today
        </button>
        <button type="button" className="db-icon-btn" data-testid="db-cal-next" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="db-cal-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((c) => (
          <div key={c} className="db-cal-wd">
            {WEEKDAYS[c]}
          </div>
        ))}
        {Array.from({ length: weeks }, (_, w) =>
          cols.map((c) => {
            const day = addDays(gridStart, w * 7 + c);
            const key = toDateString(day);
            const inMonth = new Date(day).getMonth() === first.getMonth();
            const items = byDay.get(key) ?? [];
            return (
              <div key={key} className={`db-cal-cell ${inMonth ? "" : "is-out"} ${drag?.day === key ? "is-drop" : ""}`} data-testid="db-cal-day" data-day={key}>
                <div className="db-cal-cell-top">
                  {p.editable && (
                    <button type="button" className="db-icon-btn db-cal-add" aria-label="New" data-testid="db-cal-add" onClick={() => void p.newRow({ props: { [prop.id]: { start: key } }, open: true })}>
                      <Icon name="plus" size={14} />
                    </button>
                  )}
                  <span className={`db-cal-num ${key === today ? "is-today" : ""}`}>{new Date(day).getDate() === 1 ? new Date(day).toLocaleString("en-US", { month: "short", day: "numeric" }) : new Date(day).getDate()}</span>
                </div>
                {items.map(({ row, cont, more }) => (
                  <CalItem key={row.id} p={p} row={row} cont={cont} more={more} cardProps={cardProps} dragging={drag?.row === row.id} onDown={(e) => beginDrag(e, row)} />
                ))}
              </div>
            );
          }),
        )}
      </div>
      {drag && (
        <DragGhost x={drag.x + 8} y={drag.y + 6} width={160}>
          <div className="db-cal-ghost">{drag.title}</div>
        </DragGhost>
      )}
      {noDate.state && (
        <Popover anchor={noDate.state.anchor} onClose={noDate.close} placement="bottom-end" width={280} testId="db-cal-nodate-list">
          <Menu>
            {undated.length === 0 && <div className="db-empty-note">Every page has a date</div>}
            {undated.slice(0, 200).map((row) => (
              <MenuItem key={row.id} icon="page" label={row.title || "Untitled"} onSelect={() => {
                noDate.close();
                p.openRow(row.id);
              }} />
            ))}
          </Menu>
        </Popover>
      )}
    </div>
  );
}
