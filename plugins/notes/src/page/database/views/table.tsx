import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageMeta } from "../../../shared/model";
import {
  CALC_LABELS,
  TITLE,
  calcsFor,
  calculate,
  isEditable,
  kindOf,
  moveViewProp,
  setCalc,
  setGroupState,
  setViewProp,
  viewProperties,
  isVisible,
  type Group,
  type Property,
  PROP_TYPES,
} from "../../../shared/database";
import { CellEditor, CellView } from "../cells";
import { Icon, TypeIcon } from "../icons";
import { DragGhost, Menu, MenuItem, Popover, startDrag, usePopover } from "../ui";
import { registerCss } from "../styles";
import { GroupLabel } from "./board";
import { useViewport } from "./list";
import type { ViewProps } from "./types";
import { exitRef, useFlip } from "../../ui/motion";

const rowExit = exitRef<HTMLDivElement>("is-row-leaving", 140);

const ROW = 33;
const GROUP_HEAD = 44;
const GUTTER = 0;

export const defaultWidth = (p: Property) => (p.id === TITLE ? 280 : p.type === "checkbox" ? 100 : p.type === "number" || p.type === "id" ? 140 : 200);

type Item =
  | { kind: "group"; group: Group; top: number; h: number }
  | { kind: "row"; row: PageMeta; group: string | null; top: number; h: number; index: number }
  | { kind: "new"; group: Group | null; top: number; h: number }
  | { kind: "more"; group: Group | null; top: number; h: number; hidden: number };

export function TableView(props: ViewProps) {
  const { m, view, result, actions, editable } = props;
  const columns = useMemo(() => viewProperties(view, m.schema).filter((p) => isVisible(view, p)), [view, m.schema]);
  const widths = columns.map((p) => Math.max(60, view.props[p.id]?.width ?? defaultWidth(p)));
  const total = widths.reduce((a, b) => a + b, 0);
  const rowWidth = total + (editable ? 40 : 0);
  const frozen = Math.max(0, Math.min(view.frozen, columns.length));
  const lefts = widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? 0) + w], [0]);
  const [sel, setSel] = useState<{ row: string; prop: string } | null>(null);
  const [editing, setEditing] = useState<{ row: string; prop: string; text?: string } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [colDrag, setColDrag] = useState<{ id: string; x: number; drop: number } | null>(null);
  const [rowDrag, setRowDrag] = useState<{ id: string; y: number; x: number; drop: { top: number; after: string | null; group: string | null } | null } | null>(null);
  const lastChecked = useRef<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const bodyScroll = useRef<HTMLDivElement | null>(null);
  const head = useRef<HTMLDivElement | null>(null);
  const addProp = usePopover();
  const calcMenu = usePopover<Property>();
  const bulkMenu = usePopover();
  const [bulkEdit, setBulkEdit] = useState<{ prop: Property; anchor: HTMLElement; rows: string[] } | null>(null);

  const limitOf = (key: string) => limits[key] ?? view.limit;

  const items = useMemo(() => {
    const out: Item[] = [];
    let top = 0;
    let index = 0;
    const pushRows = (rows: PageMeta[], group: Group | null) => {
      const key = group?.key ?? "";
      const limit = limitOf(key);
      const shown = rows.slice(0, limit);
      for (const row of shown) {
        out.push({ kind: "row", row, group: group?.key ?? null, top, h: ROW, index: index++ });
        top += ROW;
      }
      if (rows.length > shown.length) {
        out.push({ kind: "more", group, top, h: ROW, hidden: rows.length - shown.length });
        top += ROW;
      }
      out.push({ kind: "new", group, top, h: ROW });
      top += ROW;
    };
    if (result.groups) {
      for (const group of result.groups) {
        if (group.hidden) continue;
        out.push({ kind: "group", group, top, h: GROUP_HEAD });
        top += GROUP_HEAD;
        if (!group.collapsed) pushRows(group.rows, group);
      }
    } else pushRows(result.rows, null);
    return { list: out, height: top };
  }, [result, limits, view.limit]);

  const flatRows = useMemo(() => items.list.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row"), [items]);
  const vp = useViewport(bodyScroll, [items.height]);
  const virtual = !view.wrap && items.list.length > 120;
  const visible = virtual ? items.list.filter((i) => i.top + i.h >= vp.top - 600 && i.top <= vp.bottom + 600) : items.list;
  const padTop = virtual ? (visible[0]?.top ?? 0) : 0;
  const padBottom = virtual ? Math.max(0, items.height - ((visible.at(-1)?.top ?? 0) + (visible.at(-1)?.h ?? 0))) : 0;

  useEffect(() => {
    setChecked((s) => {
      const live = new Set(result.rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [result.rows]);

  const cellEl = (row: string, prop: string) => root.current?.querySelector<HTMLElement>(`[data-cell="${row}:${prop}"]`) ?? null;

  const moveSel = (dr: number, dc: number) => {
    if (!sel) return;
    const ri = flatRows.findIndex((r) => r.row.id === sel.row);
    const ci = columns.findIndex((c) => c.id === sel.prop);
    const nr = flatRows[Math.max(0, Math.min(flatRows.length - 1, ri + dr))];
    const nc = columns[Math.max(0, Math.min(columns.length - 1, ci + dc))];
    if (nr && nc) {
      setSel({ row: nr.row.id, prop: nc.id });
      requestAnimationFrame(() => cellEl(nr.row.id, nc.id)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  };

  const startEdit = (row: PageMeta, prop: Property, text?: string) => {
    if (prop.type === "checkbox") {
      actions.setValue(row.id, prop, row.props[prop.id] !== true);
      return;
    }
    if (!isEditable(prop.type)) return;
    setSel({ row: row.id, prop: prop.id });
    setEditing({ row: row.id, prop: prop.id, ...(text !== undefined ? { text } : {}) });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!sel || editing) return;
    if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]")) return;
    const row = m.store.pages.get(sel.row);
    const prop = columns.find((c) => c.id === sel.prop);
    if (!row || !prop) return;
    const keys: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (keys[e.key]) {
      e.preventDefault();
      moveSel(...keys[e.key]!);
    } else if (e.key === "Tab") {
      e.preventDefault();
      moveSel(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) props.openRow(row.id);
      else startEdit(row, prop);
    } else if (e.key === "Escape") setSel(null);
    else if ((e.key === "Backspace" || e.key === "Delete") && isEditable(prop.type)) {
      e.preventDefault();
      actions.setValue(row.id, prop, prop.type === "title" ? "" : null);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && ["title", "text", "number", "url", "email", "phone"].includes(prop.type)) {
      e.preventDefault();
      startEdit(row, prop, e.key);
    }
  };

  const toggleCheck = (id: string, shift: boolean) => {
    setChecked((s) => {
      const next = new Set(s);
      if (shift && lastChecked.current) {
        const a = flatRows.findIndex((r) => r.row.id === lastChecked.current);
        const b = flatRows.findIndex((r) => r.row.id === id);
        if (a >= 0 && b >= 0) for (const r of flatRows.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(r.row.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      lastChecked.current = id;
      return next;
    });
  };

  const syncScroll = () => {
    const x = bodyScroll.current?.scrollLeft ?? 0;
    head.current?.style.setProperty("--sx", `${x}px`);
    root.current?.style.setProperty("--sx", `${x}px`);
    root.current?.classList.toggle("is-scrolled-x", x > 0);
  };
  useLayoutEffect(syncScroll);

  useEffect(() => {
    const el = head.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const scroller = el.parentElement?.closest<HTMLElement>(".n-scroller, .db-peek-scroll") ?? null;
    const observer = new IntersectionObserver(([entry]) => el.classList.toggle("is-stuck", !!entry && entry.intersectionRatio < 1 && entry.boundingClientRect.top <= (entry.rootBounds?.top ?? 0) + 1), { root: scroller, rootMargin: "-1px 0px 0px 0px", threshold: [1] });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const startResize = (e: React.PointerEvent, prop: Property, width: number) => {
    e.preventDefault();
    e.stopPropagation();
    const header = (e.currentTarget as HTMLElement).parentElement!;
    document.body.classList.add("db-resizing");
    let w = width;
    startDrag(e, {
      threshold: 0,
      onMove: (_ev, { dx }) => {
        w = Math.max(60, Math.round(width + dx));
        header.style.width = `${w}px`;
        for (const el of root.current?.querySelectorAll<HTMLElement>(`[data-col="${prop.id}"]`) ?? []) el.style.width = `${w}px`;
      },
      onEnd: () => {
        document.body.classList.remove("db-resizing");
        if (w !== width) setViewProp(m.doc, view.id, prop.id, { width: w });
      },
    });
  };

  const startColDrag = (e: React.PointerEvent, prop: Property, index: number) => {
    if (e.button !== 0 || !editable) return;
    const headRect = head.current!.getBoundingClientRect();
    startDrag(e, {
      onMove: (ev) => {
        const sx = bodyScroll.current?.scrollLeft ?? 0;
        const x = ev.clientX - headRect.left + sx - GUTTER;
        let drop = columns.length;
        for (let i = 0; i < columns.length; i++) {
          if (x < (lefts[i] ?? 0) + (widths[i] ?? 0) / 2) {
            drop = i;
            break;
          }
        }
        if (prop.id !== TITLE && drop === 0 && columns[0]?.id === TITLE) drop = 1;
        setColDrag({ id: prop.id, x: ev.clientX, drop });
      },
      onEnd: (_ev, moved) => {
        setColDrag((d) => {
          if (moved && d) {
            const without = columns.filter((c) => c.id !== prop.id);
            const target = d.drop > index ? d.drop - 1 : d.drop;
            const after = target <= 0 ? null : without[target - 1]?.id ?? null;
            if (target !== index) moveViewProp(m.doc, view, m.schema, prop.id, after);
          }
          return null;
        });
      },
    });
  };

  const startRowDrag = (e: React.PointerEvent, row: PageMeta) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const body = bodyScroll.current!;
    let lastDrop: { top: number; after: string | null; group: string | null } | null = null;
    startDrag(e, {
      onMove: (ev) => {
        const rect = body.getBoundingClientRect();
        const y = ev.clientY - rect.top;
        let drop: { top: number; after: string | null; group: string | null } | null = null;
        const rowsOnly = items.list.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row");
        const groupItems = items.list.filter((i) => i.kind === "group" || i.kind === "new");
        for (const it of rowsOnly) {
          if (y >= it.top && y < it.top + it.h) {
            const before = y < it.top + it.h / 2;
            if (before) {
              const prev = rowsOnly.find((r) => r.top === it.top - ROW && r.group === it.group);
              drop = { top: it.top, after: prev ? prev.row.id : null, group: it.group };
              if (!prev) {
                const idx = result.rows.findIndex((r) => r.id === it.row.id);
                drop.after = idx > 0 ? result.rows[idx - 1]!.id : null;
              }
            } else drop = { top: it.top + it.h, after: it.row.id, group: it.group };
            break;
          }
        }
        if (!drop) {
          for (const g of groupItems) {
            if (g.kind === "new" && y >= g.top - 4 && y < g.top + g.h) {
              const groupKey = g.group?.key ?? null;
              const last = [...rowsOnly].reverse().find((r) => r.group === groupKey);
              drop = { top: g.top, after: last ? last.row.id : null, group: groupKey };
            }
          }
        }
        lastDrop = drop;
        setRowDrag({ id: row.id, x: ev.clientX, y: ev.clientY, drop });
      },
      onEnd: (_ev, moved) => {
        setRowDrag(null);
        const target = lastDrop;
        if (!moved || !target) return;
        const from = items.list.find((i) => i.kind === "row" && i.row.id === row.id) as Extract<Item, { kind: "row" }> | undefined;
        if (target.after !== row.id && !view.sorts.length) actions.moveRow(row.id, target.after);
        if (view.groupBy && from && target.group !== null && from.group !== target.group) actions.moveToGroup(row, view.groupBy.prop, from.group ?? "", target.group);
      },
    });
  };

  const checkedRows = result.rows.filter((r) => checked.has(r.id));
  const editingRow = editing ? m.store.pages.get(editing.row) : null;
  const editingProp = editing ? m.schema.find((p) => p.id === editing.prop) : null;

  const renderRow = (it: Extract<Item, { kind: "row" }>) => {
    const { row } = it;
    const isChecked = checked.has(row.id);
    return (
      <div key={row.id} ref={virtual ? undefined : rowExit} className={`db-tr ${isChecked ? "is-checked" : ""} ${rowDrag?.id === row.id ? "is-dragging" : ""}`} data-testid="db-row" data-row={row.id} style={{ width: rowWidth, minHeight: ROW, ...(view.wrap ? {} : { height: ROW }) }} onContextMenu={(e) => {
        e.preventDefault();
        props.openRowMenu(row, { x: e.clientX, y: e.clientY });
      }}>
        <div className="db-gutter">
          <span className="db-row-handle" data-testid="db-row-handle" onPointerDown={(e) => startRowDrag(e, row)} onClick={(e) => props.openRowMenu(row, e.currentTarget)}>
            <Icon name="drag" size={14} />
          </span>
          <span className={`db-row-check db-check ${isChecked ? "is-on" : ""}`} data-testid="db-row-check" onPointerDown={(e) => {
            e.preventDefault();
            toggleCheck(row.id, e.shiftKey);
          }}>
            {isChecked && <Icon name="check" size={12} strokeWidth={2} />}
          </span>
        </div>
        {columns.map((p, ci) => {
          const isSel = sel?.row === row.id && sel.prop === p.id;
          return (
            <div
              key={p.id}
              data-col={p.id}
              data-cell={`${row.id}:${p.id}`}
              data-testid="db-cell"
              data-prop={p.name}
              className={`db-td t-${p.type} ${isSel ? "is-sel" : ""} ${ci < frozen ? "is-frozen" : ""} ${ci === frozen - 1 ? "is-frozen-edge" : ""} ${view.wrap ? "is-wrap" : ""}`}
              style={{ width: widths[ci], ...(ci < frozen ? { left: lefts[ci] } : {}) }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(".db-open-btn")) return;
                if (isSel || p.type === "checkbox" || p.type === "title" || isEditable(p.type)) startEdit(row, p);
                else setSel({ row: row.id, prop: p.id });
                root.current?.focus({ preventScroll: true });
              }}
            >
              <CellView m={m} row={row} prop={p} wrap={view.wrap} />
              {p.id === TITLE && (
                <button type="button" className="db-open-btn" data-testid="db-open-row" onClick={(e) => {
                  e.stopPropagation();
                  props.openRow(row.id);
                }}>
                  <Icon name={m.settings.openAs === "center" ? "centerPeek" : m.settings.openAs === "full" ? "fullPage" : "sidePeek"} size={14} />
                  Open
                </button>
              )}
            </div>
          );
        })}
        <div className="db-td db-td-fill" />
      </div>
    );
  };

  const renderItem = (it: Item): ReactNode => {
    if (it.kind === "row") return renderRow(it);
    if (it.kind === "group") {
      const g = it.group;
      return (
        <div key={`g:${g.key}`} className="db-tgroup" data-testid="db-table-group" data-group={g.key} style={{ height: GROUP_HEAD }}>
          <div className="db-tgroup-sticky">
            <button type="button" className="db-icon-btn" aria-label={g.collapsed ? "Expand group" : "Collapse group"} onClick={() => setGroupState(m.doc, view.id, g.key, { collapsed: !g.collapsed })}>
              <Icon name={g.collapsed ? "chevronRight" : "chevronDown"} size={14} />
            </button>
            <GroupLabel m={m} group={g} />
            <span className="db-count">{g.rows.length}</span>
            <button type="button" className="db-icon-btn db-tgroup-add" aria-label="New page in group" onClick={() => void props.newRow({ group: { prop: view.groupBy!.prop, key: g.key } })}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>
      );
    }
    if (it.kind === "more")
      return (
        <div key={`m:${it.group?.key ?? ""}`} className="db-tnew db-tmore" style={{ width: rowWidth }} onClick={() => setLimits((l) => ({ ...l, [it.group?.key ?? ""]: limitOf(it.group?.key ?? "") + Math.max(50, view.limit) }))}>
          <Icon name="arrowDown" size={14} />
          Load more
          <span className="db-count">{it.hidden}</span>
        </div>
      );
    return (
      <div
        key={`n:${it.group?.key ?? ""}`}
        className="db-tnew"
        data-testid="db-table-new"
        style={{ width: rowWidth }}
        onClick={async () => {
          const id = await props.newRow({ ...(it.group && view.groupBy ? { group: { prop: view.groupBy.prop, key: it.group.key } } : {}), open: false });
          setSel({ row: id, prop: TITLE });
          requestAnimationFrame(() => setEditing({ row: id, prop: TITLE }));
        }}
      >
        <Icon name="plus" size={14} />
        New page
      </div>
    );
  };

  const allChecked = result.rows.length > 0 && checked.size === result.rows.length;

  useFlip(root, ".db-tr[data-row]", "data-row", [virtual ? null : result], { enter: true });
  return (
    <div
      ref={root}
      className="db-table"
      data-testid="db-table"
      tabIndex={-1}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node) && !(e.relatedTarget as Element | null)?.closest?.(".db-pop")) setSel((s) => (editing ? s : null));
      }}
    >
      {checked.size > 0 && (
        <div className="db-bulk" data-testid="db-bulk">
          <span className="db-bulk-count">{checked.size} selected</span>
          <button type="button" className="db-btn" onClick={(e) => bulkMenu.open(e.currentTarget)} data-testid="db-bulk-edit">
            <Icon name="edit" size={14} /> Edit property
          </button>
          <button type="button" className="db-btn" data-testid="db-bulk-duplicate" onClick={async () => {
            await actions.duplicateRows(checkedRows.map((r) => r.id));
            setChecked(new Set());
          }}>
            <Icon name="copy" size={14} /> Duplicate
          </button>
          <button type="button" className="db-btn is-danger" data-testid="db-bulk-delete" onClick={() => {
            actions.deleteRows([...checked]);
            setChecked(new Set());
          }}>
            <Icon name="trash" size={14} /> Delete
          </button>
          <button type="button" className="db-icon-btn" aria-label="Clear selection" onClick={() => setChecked(new Set())}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div className="db-thead-wrap" ref={head}>
        <div className="db-thead" style={{ width: rowWidth }}>
          <div className="db-gutter db-gutter-head">
            <span className={`db-row-check db-check ${allChecked ? "is-on" : ""} ${checked.size ? "is-visible" : ""}`} data-testid="db-check-all" onPointerDown={(e) => {
              e.preventDefault();
              setChecked(allChecked ? new Set() : new Set(result.rows.map((r) => r.id)));
            }}>
              {allChecked && <Icon name="check" size={12} strokeWidth={2} />}
            </span>
          </div>
          {columns.map((p, ci) => (
            <div
              key={p.id}
              data-col={p.id}
              data-testid="db-th"
              data-prop={p.name}
              className={`db-th ${ci < frozen ? "is-frozen" : ""} ${ci === frozen - 1 ? "is-frozen-edge" : ""} ${colDrag?.id === p.id ? "is-dragging" : ""}`}
              style={{ width: widths[ci], ...(ci < frozen ? { left: lefts[ci] } : {}) }}
              onPointerDown={(e) => startColDrag(e, p, ci)}
              onClick={(e) => {
                if (colDrag) return;
                props.openPropertyMenu(p.id, e.currentTarget);
              }}
            >
              <TypeIcon type={p.type} size={14} className="db-th-icon" />
              <span className="db-th-name">{p.name || "Untitled"}</span>
              {editable && <span className="db-resize" data-testid="db-resize" onPointerDown={(e) => startResize(e, p, widths[ci]!)} onClick={(e) => e.stopPropagation()} />}
            </div>
          ))}
          {editable && (
            <div className="db-th db-th-add" data-testid="db-add-property" onClick={(e) => addProp.open(e.currentTarget)}>
              <Icon name="plus" size={14} />
            </div>
          )}
          {colDrag && <div className="db-drop-line" style={{ left: GUTTER + (lefts[colDrag.drop] ?? total) - 1 - 0, top: 0, width: 2, height: "100%", transform: "translateX(calc(-1 * var(--sx, 0px)))" }} />}
        </div>
      </div>
      <div ref={bodyScroll} className="db-tbody-scroll" onScroll={syncScroll}>
        <div className="db-tbody" style={{ width: rowWidth, height: virtual ? items.height : undefined, paddingTop: padTop, paddingBottom: padBottom, position: "relative" }}>
          {visible.map(renderItem)}
          {rowDrag?.drop && <div className="db-drop-line" style={{ top: rowDrag.drop.top - 1, left: 0, width: total, height: 2 }} />}
        </div>
        <div className="db-tfoot" style={{ width: rowWidth }}>
          {columns.map((p, ci) => {
            const fn = view.calcs[p.id] ?? "none";
            const value = fn === "none" ? "" : calculate(m.ctx, result.rows, p, fn);
            return (
              <div key={p.id} data-col={p.id} className={`db-tf ${fn !== "none" ? "has-value" : ""} ${ci < frozen ? "is-frozen" : ""}`} data-testid="db-calc" data-prop={p.name} style={{ width: widths[ci], ...(ci < frozen ? { left: lefts[ci] } : {}) }} onClick={(e) => editable && calcMenu.open(e.currentTarget, p)}>
                {fn === "none" ? (
                  <span className="db-tf-hint">
                    Calculate <Icon name="chevronDown" size={12} />
                  </span>
                ) : (
                  <>
                    <span className="db-tf-label">{CALC_LABELS[fn].replace("Count all", "Count").replace("Count values", "Values").replace("Count unique values", "Unique")}</span>
                    <span className="db-tf-value" data-testid="db-calc-value">{value}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {editing && editingRow && editingProp && (
        <CellEditor
          m={m}
          actions={actions}
          row={editingRow}
          prop={editingProp}
          anchor={cellEl(editing.row, editing.prop)}
          {...(editing.text !== undefined ? { initialText: editing.text } : {})}
          onClose={() => {
            setEditing(null);
            root.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {addProp.state && (
        <Popover anchor={addProp.state.anchor} onClose={addProp.close} width={240} testId="db-add-property-menu">
          <AddPropertyMenu onPick={(type) => {
            addProp.close();
            const id = actions.newProperty(type, { view });
            requestAnimationFrame(() => {
              const el = root.current?.querySelector<HTMLElement>(`.db-th[data-col="${id}"]`);
              if (el) props.openPropertyMenu(id, el);
            });
          }} />
        </Popover>
      )}
      {calcMenu.state && (
        <Popover anchor={calcMenu.state.anchor} onClose={calcMenu.close} width={200} testId="db-calc-menu">
          <Menu>
            {calcsFor(kindOf(m.ctx, calcMenu.state.value)).map((fn) => (
              <MenuItem key={fn} label={CALC_LABELS[fn]} checked={(view.calcs[calcMenu.state!.value.id] ?? "none") === fn} onSelect={() => {
                setCalc(m.doc, view.id, calcMenu.state!.value.id, fn);
                calcMenu.close();
              }} />
            ))}
          </Menu>
        </Popover>
      )}
      {bulkMenu.state && (
        <Popover anchor={bulkMenu.state.anchor} onClose={bulkMenu.close} width={220}>
          <Menu>
            {m.schema.filter((p) => isEditable(p.type)).map((p) => (
              <MenuItem key={p.id} icon={<TypeIcon type={p.type} size={14} />} label={p.name} onSelect={(el) => {
                const first = checkedRows[0];
                if (!first) return;
                bulkMenu.close();
                setBulkEdit({ prop: p, anchor: el, rows: checkedRows.map((r) => r.id) });
              }} />
            ))}
          </Menu>
        </Popover>
      )}
      {bulkEdit && <BulkEditor {...props} edit={bulkEdit} onClose={() => setBulkEdit(null)} />}
      {rowDrag && <DragGhost x={rowDrag.x + 8} y={rowDrag.y - 14}><div className="db-ghost-row">{m.store.pages.get(rowDrag.id)?.title || "Untitled"}</div></DragGhost>}
      {colDrag && <DragGhost x={colDrag.x - 40} y={(head.current?.getBoundingClientRect().top ?? 0) + 2}><div className="db-ghost-row">{m.schema.find((p) => p.id === colDrag.id)?.name}</div></DragGhost>}
    </div>
  );
}

function BulkEditor({ m, actions, edit, onClose }: ViewProps & { edit: { prop: Property; anchor: HTMLElement; rows: string[] }; onClose: () => void }) {
  const first = m.store.pages.get(edit.rows[0]!);
  if (!first) return null;
  const proxy = {
    ...actions,
    setValue: (_row: string, prop: Property, value: unknown) => {
      m.tree.transact(() => {
        for (const id of edit.rows) actions.setValue(id, prop, value);
      });
    },
  };
  return <CellEditor m={m} actions={proxy} row={first} prop={edit.prop} anchor={edit.anchor} onClose={onClose} />;
}

export function AddPropertyMenu({ onPick }: { onPick: (type: Property["type"]) => void }) {
  const [q, setQ] = useState("");
  const list = PROP_LIST.filter((p) => p.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Menu autoFocus={false}>
      <div className="db-menu-pad">
        <input className="db-input" autoFocus placeholder="Search for a property type…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="db-type-search" onKeyDown={(e) => {
          if (e.key === "Enter" && list[0]) onPick(list[0].type);
        }} />
      </div>
      <div className="db-menu-label">Type</div>
      {list.map((t) => (
        <MenuItem key={t.type} testId="db-type-option" icon={<TypeIcon type={t.type} size={16} />} label={t.label} onSelect={() => onPick(t.type)} />
      ))}
    </Menu>
  );
}

const PROP_LIST = PROP_TYPES;

registerCss(
  "table",
  `
.db-table { position: relative; outline: none; font-size: var(--n-t-body, 13px); --sx: 0px; --db-line: var(--n-divider); --db-frozen: transparent; }
.db-table.is-scrolled-x { --db-frozen: var(--n-surface); }
.db-thead-wrap { position: sticky; top: 0; z-index: 4; overflow: hidden; background: transparent; }
.db-thead-wrap.is-stuck { background: var(--n-sheet-tint); background-clip: content-box; -webkit-backdrop-filter: var(--n-glass-sheet-filter); backdrop-filter: var(--n-glass-sheet-filter); }
.db-thead { display: flex; height: 33px; transform: translateX(calc(-1 * var(--sx))); position: relative; }
.db-th { position: relative; display: flex; align-items: center; gap: 6px; height: 33px; padding: 0 8px; color: var(--n-text-2); font-size: var(--n-t-small, 12px); font-weight: var(--n-w-medium, 500); flex: none; cursor: default; user-select: none; border-top: 0.5px solid var(--db-line); border-bottom: 0.5px solid var(--db-line); border-right: 0.5px solid var(--db-line); background: transparent; }
.db-th:hover { background: var(--n-tool-hover); }
.db-th.is-frozen { z-index: 2; transform: translateX(var(--sx)); background: var(--db-frozen); }
.db-th.is-frozen:hover { background: linear-gradient(var(--n-tool-hover), var(--n-tool-hover)), var(--db-frozen); }
.db-th.is-dragging { opacity: .4; }
.db-th-icon { color: var(--n-text-3); }
.db-th-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-th-add { width: 40px; justify-content: center; border-right: none; color: var(--n-text-3); }
.db-resize { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 3; }
.db-resize:hover, body.db-resizing .db-resize:active { background: linear-gradient(90deg, transparent 2px, var(--n-form-accent) 2px, var(--n-form-accent) 4px, transparent 4px); }
.db-gutter { position: sticky; left: 0; width: 0; flex: none; z-index: 3; }
.db-gutter-head .db-row-check { position: absolute; left: -26px; top: 9.5px; opacity: 0; }
.db-thead:hover .db-gutter-head .db-row-check, .db-gutter-head .db-row-check.is-visible { opacity: 1; }
.db-tbody-scroll { overflow-x: auto; overflow-y: visible; padding-left: 52px; margin-left: -52px; scrollbar-width: thin; }
.db-thead-wrap { margin-left: -52px; padding-left: 52px; }
.db-tr { display: flex; position: relative; }
.db-tr:hover { background: var(--n-hover); }
.db-tr.is-checked { background: color-mix(in srgb, var(--n-form-accent) 12%, transparent); }
.db-tr.is-dragging { opacity: .45; }
.db-tr .db-gutter { display: flex; align-items: center; }
.db-row-handle { position: absolute; left: -46px; top: 7.5px; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; color: var(--n-text-3); border-radius: var(--n-r-control, 4px); opacity: 0; cursor: grab; }
.db-row-handle:hover { background: var(--n-tool-hover); }
.db-tr .db-row-check { position: absolute; left: -24px; top: 9.5px; opacity: 0; }
.db-tr:hover .db-row-handle, .db-tr:hover .db-row-check, .db-tr.is-checked .db-row-check, .db-table:has(.db-tr.is-checked) .db-row-check { opacity: 1; }
.db-td { position: relative; display: flex; align-items: center; flex: none; min-height: 33px; padding: 0 8px; border-right: 0.5px solid var(--db-line); border-bottom: 0.5px solid var(--db-line); overflow: hidden; white-space: nowrap; cursor: default; background: transparent; }
.db-td.is-wrap { white-space: normal; align-items: flex-start; padding-top: 7px; padding-bottom: 6px; }
.db-td.is-wrap .db-cell-value { white-space: normal; word-break: break-word; }
.db-td.is-frozen { position: sticky; z-index: 2; background: var(--db-frozen); }
.db-table.is-scrolled-x .db-tr:hover .db-td.is-frozen { background: linear-gradient(var(--n-hover), var(--n-hover)), var(--db-frozen); }
.db-table.is-scrolled-x .db-tr.is-checked .db-td.is-frozen { background: linear-gradient(color-mix(in srgb, var(--n-form-accent) 12%, transparent), color-mix(in srgb, var(--n-form-accent) 12%, transparent)), var(--db-frozen); }
.db-td-fill { flex: 1; border-right: none; min-width: 40px; }
.db-td.is-sel { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--n-form-accent) 70%, transparent); border-radius: 2px; }
.db-cell-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; display: block; width: 100%; }
.db-cell-value.db-tags, .db-cell-value.db-people, .db-cell-value.db-relations, .db-cell-value.db-files, .db-cell-value.db-title-value, .db-cell-value.db-num-bar { display: flex; }
.db-page.is-full .db-tbody-scroll, .db-page.is-full .db-thead-wrap { margin-right: calc(-1 * var(--db-gutter)); padding-right: var(--db-gutter); }
.db-td .db-tags, .db-td .db-people, .db-td .db-relations { flex-wrap: nowrap; }
.db-td.is-wrap .db-tags, .db-td.is-wrap .db-people, .db-td.is-wrap .db-relations { flex-wrap: wrap; }
.db-td.t-checkbox { justify-content: flex-start; }
.db-td.t-title .db-cell-value { padding-right: 4px; }
.db-open-btn { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: var(--n-r-control, 4px); border: none; background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); box-shadow: var(--n-glass-edge); color: var(--n-text); font-size: var(--n-t-small, 12px); font-weight: var(--n-w-medium, 500); cursor: default; }
.db-open-btn:hover { background: linear-gradient(var(--n-tool-hover), var(--n-tool-hover)), var(--n-glass); }
.db-tr:hover .db-open-btn { display: inline-flex; }
.db-tgroup { display: flex; align-items: flex-end; padding-bottom: 4px; }
.db-tgroup-sticky { position: sticky; left: 0; display: flex; align-items: center; gap: 6px; height: 32px; }
.db-tgroup-add { opacity: 0; }
.db-tgroup:hover .db-tgroup-add { opacity: 1; }
.db-count { color: var(--n-text-3); font-size: var(--n-t-small, 12px); font-variant-numeric: tabular-nums; }
.db-tnew { display: flex; align-items: center; gap: 6px; height: 33px; padding-left: 8px; color: var(--n-text-3); cursor: default; border-bottom: 0.5px solid var(--db-line); position: sticky; left: 0; }
.db-tnew:hover { background: var(--n-hover); color: var(--n-text-2); }
.db-tfoot { display: flex; height: 33px; }
.db-tf { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 0 8px; color: var(--n-text-3); font-size: var(--n-t-small, 12px); cursor: default; white-space: nowrap; overflow: hidden; }
.db-tf.is-frozen { position: sticky; z-index: 2; background: var(--db-frozen); }
.db-tf-hint { opacity: 0; display: inline-flex; align-items: center; gap: 2px; font-size: var(--n-t-caption, 11px); }
.db-tfoot:hover .db-tf-hint { opacity: 1; }
.db-tf:hover { background: var(--n-tool-hover); }
.db-tf-label { font-size: var(--n-t-caption, 11px); }
.db-tf-value { color: var(--n-text); font-size: var(--n-t-body, 13px); font-variant-numeric: tabular-nums; }
.db-bulk { position: absolute; top: -40px; left: 0; z-index: 6; display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 4px 0 12px; border-radius: var(--n-r-tile, 8px); background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); box-shadow: var(--n-glass-edge), var(--n-shadow); }
.db-bulk-count { color: var(--n-text); font-size: var(--n-t-body, 13px); font-weight: var(--n-w-medium, 500); margin-right: 6px; }
.db-ghost-row { padding: 6px 10px; font-size: var(--n-t-body, 13px); font-weight: var(--n-w-medium, 500); white-space: nowrap; }
`,
);
