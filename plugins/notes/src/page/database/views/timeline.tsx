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
  toDateString,
  viewProperties,
  type DateValue,
  type Property,
  type View,
} from "../../../shared/database";
import { CellView, RowIcon } from "../cells";
import { Icon } from "../icons";
import { registerCss } from "../styles";
import { Menu, MenuItem, Popover, startDrag, usePopover } from "../ui";
import type { ViewProps } from "./types";
import { EASE, MOTION, useFlip } from "../../ui/motion";

registerCss(
  "timeline",
  `
.db-tl { display: flex; flex-direction: column; min-width: 0; }
.db-tl-head { display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 2px; }
.db-tl-title { font-size: var(--n-t-body, 13px); font-weight: var(--n-w-semibold, 600); flex: 1; min-width: 0; }
.db-tl-scroll { position: relative; overflow: auto; max-height: 640px; border-top: 0.5px solid var(--n-divider); border-bottom: 0.5px solid var(--n-divider); overscroll-behavior-x: contain; }
.db-tl-inner { position: relative; }
.db-tl-header { position: sticky; top: 0; z-index: 4; display: flex; height: 48px; background: var(--n-surface); border-bottom: 0.5px solid var(--n-divider); }
.db-tl-corner { position: sticky; left: 0; z-index: 5; flex: none; background: var(--n-surface); border-right: 0.5px solid var(--n-divider); display: flex; align-items: flex-end; }
.db-tl-corner-cell { height: 24px; line-height: 24px; padding: 0 8px; font-size: 12px; color: var(--n-text-2); border-right: 0.5px solid var(--n-divider); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: none; }
.db-tl-scale { position: relative; flex: none; }
.db-tl-scale-top, .db-tl-scale-bottom { position: absolute; left: 0; right: 0; height: 24px; }
.db-tl-scale-top { top: 0; }
.db-tl-scale-bottom { top: 24px; }
.db-tl-tick { position: absolute; top: 0; height: 24px; line-height: 24px; font-size: 12px; color: var(--n-text-2); white-space: nowrap; overflow: hidden; padding-left: 4px; border-left: 0.5px solid var(--n-divider); font-variant-numeric: tabular-nums; }
.db-tl-scale-top .db-tl-tick { font-weight: 600; color: var(--n-text); overflow: visible; padding-left: 0; }
.db-tl-month-label { position: sticky; display: inline-block; padding: 0 6px; background: var(--n-surface); }
.db-tl-tick.is-today { color: var(--n-red); font-weight: 600; }
.db-tl-tick.is-weekend { background: var(--n-raised); }
.db-tl-rows { position: relative; }
.db-tl-row { position: absolute; left: 0; display: flex; height: 34px; }
.db-tl-row:hover .db-tl-left, .db-tl-row:hover .db-tl-lane { background-color: color-mix(in srgb, var(--n-hover) 50%, transparent); }
.db-tl-left { position: sticky; left: 0; z-index: 3; flex: none; display: flex; background: var(--n-surface); border-right: 0.5px solid var(--n-divider); border-bottom: 0.5px solid var(--n-divider); }
.db-tl-cell { height: 34px; padding: 0 8px; display: flex; align-items: center; border-right: 0.5px solid var(--n-divider); overflow: hidden; white-space: nowrap; min-width: 0; flex: none; }
.db-tl-cell.is-title { cursor: default; }
.db-tl-cell.is-title:hover { background: var(--n-hover); }
.db-tl-lane { position: relative; flex: none; height: 34px; border-bottom: 0.5px solid color-mix(in srgb, var(--n-divider) 50%, transparent); }
.db-tl-bar { position: absolute; top: 5px; height: 24px; border-radius: 5px; background: var(--n-control); box-shadow: 0 0 0 0.5px var(--n-panel-border), 0 1px 2px rgba(0,0,0,.1); display: flex; align-items: center; gap: 5px; padding: 0 10px; font-size: 13px; font-weight: 500; white-space: nowrap; min-width: 6px; cursor: default; user-select: none; z-index: 1; }
.db-tl-bar:hover { box-shadow: 0 0 0 1px var(--n-form-accent), 0 1px 3px rgba(0,0,0,.12); }
.db-tl-bar.is-active { box-shadow: 0 0 0 1.5px var(--n-form-accent), 0 2px 6px rgba(0,0,0,.16); }
.db-tl-bar-label { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.db-tl-bar.is-short { padding: 0; justify-content: center; }
.db-tl-outside { position: absolute; top: 5px; height: 24px; display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 500; white-space: nowrap; pointer-events: none; color: var(--n-text); z-index: 3; padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, var(--n-surface) 85%, transparent); }
.db-tl-handle { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; }
.db-tl-handle::after { content: ""; position: absolute; top: 6px; bottom: 6px; left: 3px; width: 2px; border-radius: 1px; background: var(--n-text-3); opacity: 0; }
.db-tl-bar:hover .db-tl-handle::after { opacity: 1; }
.db-tl-handle.is-start { left: -2px; }
.db-tl-handle.is-end { right: -2px; }
.db-tl-placeholder { position: absolute; top: 5px; height: 24px; border-radius: 5px; border: 1px dashed var(--n-text-3); display: flex; align-items: center; justify-content: center; color: var(--n-text-3); pointer-events: none; }
.db-tl-today { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--n-red); z-index: 2; pointer-events: none; }
.db-tl-today-dot { position: absolute; top: 44px; width: 8px; height: 8px; margin-left: -4px; border-radius: 4px; background: var(--n-red); z-index: 5; pointer-events: none; }
.db-tl-weekend { position: absolute; top: 0; bottom: 0; background: var(--n-raised); pointer-events: none; }
.db-tl-new { position: sticky; left: 0; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; color: var(--n-text-2); font-size: var(--n-t-body, 13px); border: none; background: transparent; cursor: default; }
.db-tl-new:hover { background: var(--n-hover); }
.db-tl-hint { padding: 48px 16px; text-align: center; color: var(--n-text-2); font-size: var(--n-t-body, 13px); }
`,
);

type Zoom = View["zoom"];
const DAY_WIDTH: Record<Zoom, number> = { day: 60, week: 28, month: 12, quarter: 4, year: 1.5 };
const PAD_DAYS: Record<Zoom, number> = { day: 21, week: 42, month: 120, quarter: 365, year: 1095 };
const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
];
const ROW = 34;
const TITLE_W = 240;
const PROP_W = 140;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["S", "M", "T", "W", "T", "F", "S"];

type Span = { start: number; end: number; time: boolean; endTime: boolean; hasEnd: boolean };

function spanOf(row: PageMeta, prop: Property, endProp: Property | undefined): Span | null {
  const d = dateValue(row, prop);
  const s = d ? parseDateString(d.start) : null;
  if (!s) return null;
  let e = parseDateString(d!.end);
  if (endProp) {
    const ed = dateValue(row, endProp);
    e = ed ? parseDateString(ed.start) : null;
  }
  return { start: startOfDay(s.ms), end: startOfDay(e ? Math.max(e.ms, s.ms) : s.ms), time: s.time, endTime: e?.time ?? false, hasEnd: !!e };
}

function moveDay(value: string, days: number): string {
  const p = parseDateString(value)!;
  return toDateString(addDays(p.ms, days), p.time);
}

type DragState = { row: string; mode: "move" | "start" | "end"; delta: number };

export function TimelineView(p: ViewProps) {
  const { m, view, result, actions } = p;
  const zoom = view.zoom;
  const tlRef = useRef<HTMLDivElement | null>(null);
  const lastZoom = useRef(zoom);
  useEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    tlRef.current?.querySelectorAll<HTMLElement>(".db-tl-scale, .db-tl-bar, .db-tl-body").forEach((el) => el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: MOTION.slow, easing: EASE.out }));
  }, [zoom]);
  const dw = DAY_WIDTH[zoom];
  const prop = m.schema.find((x) => x.id === view.dateProp);
  const endProp = view.endProp ? m.schema.find((x) => x.id === view.endProp && x.id !== view.dateProp) : undefined;
  const editable = !!prop && isEditable(prop.type) && p.editable && (!endProp || isEditable(endProp.type));
  const scroll = useRef<HTMLDivElement | null>(null);
  const zoomMenu = usePopover();
  const [viewport, setViewport] = useState({ top: 0, height: 640 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<{ row: string; day: number } | null>(null);
  const tableProps = useMemo(() => viewProperties(view, m.schema).filter((x) => x.id !== TITLE && isVisible(view, x)), [view, m.schema]);
  const leftW = view.showTable ? TITLE_W + tableProps.length * PROP_W : 0;

  const spans = useMemo(() => {
    const map = new Map<string, Span>();
    if (!prop) return map;
    for (const row of result.rows) {
      const s = spanOf(row, prop, endProp);
      if (s) map.set(row.id, s);
    }
    return map;
  }, [result.rows, prop, endProp]);

  const today = startOfDay(Date.now());
  const origin = useMemo(() => {
    let min = today;
    for (const s of spans.values()) if (s.start < min) min = s.start;
    const d = new Date(addDays(min, -PAD_DAYS[zoom]));
    return zoom === "quarter" || zoom === "year" ? new Date(d.getFullYear(), 0, 1).getTime() : new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }, [spans, zoom, today]);
  const totalDays = useMemo(() => {
    let max = today;
    for (const s of spans.values()) if (s.end > max) max = s.end;
    const end = addMonths(addDays(max, PAD_DAYS[zoom]), 1);
    return Math.max(daysBetween(origin, end), Math.ceil(2400 / dw));
  }, [spans, zoom, origin, today, dw]);
  const gridW = totalDays * dw;
  const xOf = (day: number) => daysBetween(origin, day) * dw;

  const scrollToToday = (smooth = false) => {
    const el = scroll.current;
    if (!el) return;
    const visible = el.clientWidth - leftW;
    el.scrollTo({ left: Math.max(0, xOf(today) - visible / 3), behavior: smooth ? "smooth" : "auto" });
  };
  const prevZoom = useRef<Zoom | null>(null);
  useLayoutEffect(() => {
    if (prevZoom.current !== zoom) {
      prevZoom.current = zoom;
      scrollToToday();
    }
  });
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const scale = useMemo(() => {
    const top: { x: number; w: number; label: string }[] = [];
    const bottom: { x: number; w: number; label: string; today?: boolean; weekend?: boolean }[] = [];
    const end = addDays(origin, totalDays);
    if (zoom === "quarter" || zoom === "year") {
      for (let y = new Date(origin).getFullYear(); new Date(y, 0, 1).getTime() < end; y++) {
        const a = new Date(y, 0, 1).getTime();
        const b = new Date(y + 1, 0, 1).getTime();
        top.push({ x: xOf(a), w: xOf(b) - xOf(a), label: String(y) });
      }
      for (let t = origin; t < end; t = addMonths(t, zoom === "quarter" ? 1 : 3)) {
        const n = addMonths(t, zoom === "quarter" ? 1 : 3);
        const d = new Date(t);
        bottom.push({ x: xOf(t), w: xOf(n) - xOf(t), label: zoom === "quarter" ? MONTHS_SHORT[d.getMonth()]! : `Q${Math.floor(d.getMonth() / 3) + 1}` });
      }
    } else {
      for (let t = origin; t < end; t = addMonths(t, 1)) {
        const n = addMonths(t, 1);
        const d = new Date(t);
        top.push({ x: xOf(t), w: xOf(n) - xOf(t), label: `${d.toLocaleString("en-US", { month: "long" })} ${d.getFullYear()}` });
      }
      const step = zoom === "month" ? 7 : 1;
      let t = origin;
      if (step === 7) while (new Date(t).getDay() !== 1) t = addDays(t, 1);
      for (; t < end; t = addDays(t, step)) {
        const d = new Date(t);
        bottom.push({
          x: xOf(t),
          w: dw * step,
          label: zoom === "day" ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getDate()}` : zoom === "week" ? `${WD[d.getDay()]}${d.getDate()}` : String(d.getDate()),
          today: step === 1 && t === today,
          weekend: step === 1 && (d.getDay() === 0 || d.getDay() === 6),
        });
      }
    }
    return { top, bottom };
  }, [origin, totalDays, zoom, dw, today]);

  const rows = result.rows;
  const rowIds = rows.map((r) => r.id).join();
  const seenRows = useRef<{ list: string; ids: Set<string>; fresh: Set<string> } | null>(null);
  if (seenRows.current?.list !== rowIds) {
    const ids = new Set(rows.map((r) => r.id));
    const before = seenRows.current?.ids;
    seenRows.current = { list: rowIds, ids, fresh: before ? new Set([...ids].filter((id) => !before.has(id))) : new Set() };
  }
  useFlip(scroll, ".db-tl-row[data-row]", "data-row", [rowIds], { enter: (el) => !!seenRows.current?.fresh.has(el.dataset.row ?? ""), skip: !!drag });
  const first = Math.max(0, Math.floor((viewport.top - 48) / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW) + 10);

  const commit = (row: PageMeta, mode: DragState["mode"], delta: number) => {
    if (!prop || !delta) return;
    const live = m.store.pages.get(row.id) ?? row;
    const current = dateValue(live, prop);
    if (!current) return;
    if (endProp) {
      const endValue = dateValue(live, endProp);
      if (mode !== "end") actions.setValue(row.id, prop, { start: moveDay(current.start, delta) });
      if (mode !== "start") {
        const base = endValue?.start ?? current.start;
        actions.setValue(row.id, endProp, { start: moveDay(base, delta) });
      }
      return;
    }
    const s = parseDateString(current.start)!;
    const e = parseDateString(current.end);
    let next: DateValue;
    if (mode === "move") next = { start: moveDay(current.start, delta), ...(current.end ? { end: moveDay(current.end, delta) } : {}) };
    else if (mode === "start") {
      const ns = addDays(s.ms, delta);
      const endMs = e?.ms ?? s.ms;
      next = startOfDay(ns) > startOfDay(endMs) ? { start: toDateString(endMs, s.time), end: toDateString(endMs, e?.time ?? s.time) } : { start: toDateString(ns, s.time), end: toDateString(endMs, e?.time ?? s.time) };
    } else {
      const base = e?.ms ?? s.ms;
      const ne = addDays(base, delta);
      next = startOfDay(ne) < startOfDay(s.ms) ? { start: current.start, end: current.start } : { start: current.start, end: toDateString(ne, e?.time ?? s.time) };
    }
    actions.setValue(row.id, prop, next);
  };

  const beginDrag = (e: React.PointerEvent, row: PageMeta, mode: DragState["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable) {
      if (mode === "move") {
        const up = () => {
          window.removeEventListener("pointerup", up);
          p.openRow(row.id);
        };
        window.addEventListener("pointerup", up);
      }
      return;
    }
    let delta = 0;
    startDrag(e, {
      threshold: 3,
      onStart: () => setDrag({ row: row.id, mode, delta: 0 }),
      onMove: (_ev, { dx }) => {
        const d = Math.round(dx / dw);
        if (d !== delta) {
          delta = d;
          setDrag({ row: row.id, mode, delta: d });
        }
      },
      onEnd: (_ev, moved) => {
        setDrag(null);
        if (!moved) {
          if (mode === "move") p.openRow(row.id);
          return;
        }
        commit(row, mode, delta);
      },
    });
  };

  const dayAt = (clientX: number, lane: HTMLElement) => addDays(origin, Math.floor((clientX - lane.getBoundingClientRect().left) / dw));

  if (!prop)
    return (
      <div className="db-tl" data-testid="db-timeline">
        <div className="db-tl-hint">Pick a date property in Layout</div>
      </div>
    );

  const zoomLabel = ZOOMS.find((z) => z.id === zoom)!.label;
  return (
    <div className="db-tl" data-testid="db-timeline" ref={tlRef}>
      <div className="db-tl-head">
        <span className="db-tl-title">{new Date(today).toLocaleString("en-US", { month: "long", year: "numeric" })}</span>
        <button type="button" className="db-btn" data-testid="db-tl-zoom" data-db-anchor-open="" onClick={(e) => zoomMenu.toggle(e.currentTarget)}>
          {zoomLabel}
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="db-btn" data-testid="db-tl-today" onClick={() => scrollToToday(true)}>
          Today
        </button>
        <button type="button" className="db-icon-btn" data-testid="db-tl-table-toggle" aria-label={view.showTable ? "Hide table" : "Show table"} title={view.showTable ? "Hide table" : "Show table"} onClick={() => actions.updateView(view.id, { showTable: !view.showTable })}>
          <Icon name="sidePeek" size={16} />
        </button>
      </div>
      <div className="db-tl-scroll" ref={scroll}>
        <div className="db-tl-inner" style={{ width: leftW + gridW, height: 48 + rows.length * ROW + (p.editable ? ROW : 0) }}>
          <div className="db-tl-header" style={{ width: leftW + gridW }}>
            {view.showTable && (
              <div className="db-tl-corner" style={{ width: leftW }}>
                <div className="db-tl-corner-cell" style={{ width: TITLE_W }}>
                  {m.schema.find((x) => x.id === TITLE)?.name ?? "Name"}
                </div>
                {tableProps.map((x) => (
                  <div key={x.id} className="db-tl-corner-cell" style={{ width: PROP_W }}>
                    {x.name}
                  </div>
                ))}
              </div>
            )}
            <div className="db-tl-scale" style={{ width: gridW }}>
              <div className="db-tl-scale-top">
                {scale.top.map((t) => (
                  <div key={t.x} className="db-tl-tick" style={{ left: t.x, width: t.w }}>
                    <span className="db-tl-month-label" style={{ left: leftW }}>
                      {t.label}
                    </span>
                  </div>
                ))}
              </div>
              <div className="db-tl-scale-bottom">
                {scale.bottom.map((t) => (
                  <div key={t.x} className={`db-tl-tick ${t.today ? "is-today" : ""} ${t.weekend ? "is-weekend" : ""}`} style={{ left: t.x, width: t.w }}>
                    {t.label}
                  </div>
                ))}
              </div>
              <div className="db-tl-today-dot" style={{ left: xOf(today) + dw / 2 }} />
            </div>
          </div>
          <div className="db-tl-rows" style={{ height: rows.length * ROW }}>
            <div className="db-tl-today" style={{ left: leftW + xOf(today) + dw / 2, height: rows.length * ROW + (p.editable ? ROW : 0) }} />
            {rows.slice(first, last).map((row, i) => {
              const index = first + i;
              const span = spans.get(row.id);
              let start = span?.start ?? 0;
              let end = span?.end ?? 0;
              const active = drag?.row === row.id;
              if (span && active) {
                if (drag.mode === "move") {
                  start = addDays(start, drag.delta);
                  end = addDays(end, drag.delta);
                } else if (drag.mode === "start") start = Math.min(addDays(start, drag.delta), end);
                else end = Math.max(addDays(end, drag.delta), start);
              }
              return (
                <div key={row.id} className="db-tl-row" data-testid="db-tl-row" data-row={row.id} style={{ top: index * ROW, width: leftW + gridW }}>
                  {view.showTable && (
                    <div className="db-tl-left" style={{ width: leftW }}>
                      <div className="db-tl-cell is-title" style={{ width: TITLE_W }} onClick={() => p.openRow(row.id)} onContextMenu={(e) => {
                        e.preventDefault();
                        p.openRowMenu(row, { x: e.clientX, y: e.clientY });
                      }}>
                        <CellView m={m} row={row} prop={m.schema.find((x) => x.id === TITLE)!} />
                      </div>
                      {tableProps.map((x) => (
                        <div key={x.id} className="db-tl-cell" style={{ width: PROP_W }}>
                          <CellView m={m} row={row} prop={x} />
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    className="db-tl-lane"
                    style={{ width: gridW }}
                    onMouseMove={(e) => {
                      if (span || !editable) return;
                      const day = dayAt(e.clientX, e.currentTarget);
                      if (hover?.row !== row.id || hover.day !== day) setHover({ row: row.id, day });
                    }}
                    onMouseLeave={() => hover?.row === row.id && setHover(null)}
                    onClick={(e) => {
                      if (span || !editable || !prop) return;
                      const day = dayAt(e.clientX, e.currentTarget);
                      actions.setValue(row.id, prop, { start: toDateString(day) });
                      setHover(null);
                    }}
                  >
                    {span && (() => {
                      const barW = Math.max(24, (daysBetween(start, end) + 1) * dw);
                      const short = barW < 96;
                      return (
                        <>
                          <div
                            className={`db-tl-bar ${active ? "is-active" : ""} ${short ? "is-short" : ""}`}
                            data-testid="db-tl-bar"
                            data-row={row.id}
                            title={row.title || "Untitled"}
                            style={{ left: xOf(start), width: barW }}
                            onPointerDown={(e) => beginDrag(e, row, "move")}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              p.openRowMenu(row, { x: e.clientX, y: e.clientY });
                            }}
                          >
                            {editable && <span className="db-tl-handle is-start" data-testid="db-tl-handle-start" onPointerDown={(e) => beginDrag(e, row, "start")} />}
                            {!short && <RowIcon m={m} row={row} size={14} />}
                            {!short && <span className={`db-tl-bar-label ${row.title ? "" : "db-untitled"}`}>{row.title || "Untitled"}</span>}
                            {editable && <span className="db-tl-handle is-end" data-testid="db-tl-handle-end" onPointerDown={(e) => beginDrag(e, row, "end")} />}
                          </div>
                          {short && (
                            <div className="db-tl-outside" style={{ left: xOf(start) + barW + 8 }}>
                              <RowIcon m={m} row={row} size={14} />
                              <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {!span && hover?.row === row.id && (
                      <div className="db-tl-placeholder" style={{ left: xOf(hover.day), width: Math.max(dw, 24) }}>
                        <Icon name="plus" size={12} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {p.editable && (
            <button type="button" className="db-tl-new" data-testid="db-tl-new"  onClick={() => void p.newRow({})}>
              <Icon name="plus" size={14} />
              New
            </button>
          )}
        </div>
      </div>
      {zoomMenu.state && (
        <Popover anchor={zoomMenu.state.anchor} onClose={zoomMenu.close} width={160} testId="db-tl-zoom-menu">
          <Menu>
            {ZOOMS.map((z) => (
              <MenuItem key={z.id} label={z.label} checked={z.id === zoom} testId={`db-tl-zoom-${z.id}`} onSelect={() => {
                zoomMenu.close();
                actions.updateView(view.id, { zoom: z.id });
              }} />
            ))}
          </Menu>
        </Popover>
      )}
    </div>
  );
}
