import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageMeta } from "../../../shared/model";
import { setGroupState, type Group } from "../../../shared/database";
import { registerCss } from "../styles";
import { Icon } from "../icons";
import { CellView, RowIcon, isEmptyCell } from "../cells";
import { DragGhost, startDrag } from "../ui";
import { GroupLabel, cardProps } from "./board";
import type { ViewProps } from "./types";
import { MOTION, useFlip, useLeaveRef } from "../../ui/motion";

registerCss(
  "list",
  `
.db-list { position: relative; }
.db-list-row { position: absolute; left: 0; right: 0; height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 6px; border-radius: 4px; cursor: default; user-select: none; }
.db-list-row:hover { background: var(--n-hover); }
.db-list-row.is-dragging { opacity: .35; }
.db-list-title { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 80px; overflow: hidden; font-weight: 500; }
.db-list-title > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-list-props { display: flex; align-items: center; gap: 12px; flex: 0 1 auto; min-width: 0; overflow: hidden; justify-content: flex-end; font-size: 13px; color: var(--n-text-2); }
.db-list-prop { flex: none; max-width: 220px; overflow: hidden; display: flex; }
.db-list-prop .db-cell-value { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.db-list-group { position: absolute; left: 0; right: 0; height: 40px; display: flex; align-items: center; gap: 6px; padding: 0 2px; cursor: default; user-select: none; }
.db-list-group .db-count { color: var(--n-text-3); font-size: 14px; }
.db-list-group-line { position: absolute; left: 0; right: 0; bottom: 0; height: 0.5px; background: var(--n-divider); }
.db-list-new { position: absolute; left: 0; right: 0; height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 6px; border: none; background: transparent; border-radius: 4px; color: var(--n-text-3); font-size: 14px; cursor: default; text-align: left; }
.db-list-new:hover { background: var(--n-hover); color: var(--n-text-2); }
.db-list-ghost { height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 8px; font-weight: 500; }
`,
);

const ROW = 34;
const HEAD = 40;

type Item =
  | { kind: "group"; group: Group; top: number; h: number }
  | { kind: "row"; row: PageMeta; group: string; top: number; h: number }
  | { kind: "new"; group: Group | null; top: number; h: number };

export function scrollParentOf(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node) {
    const s = getComputedStyle(node);
    if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return window;
}

export function useViewport(ref: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const [vp, setVp] = useState({ top: 0, bottom: 1200 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = scrollParentOf(el);
    const update = () => {
      const r = el.getBoundingClientRect();
      const ph = parent === window ? window.innerHeight : (parent as HTMLElement).getBoundingClientRect().bottom;
      const pt = parent === window ? 0 : (parent as HTMLElement).getBoundingClientRect().top;
      setVp({ top: pt - r.top, bottom: ph - r.top });
    };
    update();
    parent.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      parent.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, deps);
  return vp;
}

export function ListView(props: ViewProps) {
  const { m, view, result, actions } = props;
  const shown = useMemo(() => cardProps(m, view), [m.schema, view]);
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ row: PageMeta; x: number; y: number; w: number; oy: number } | null>(null);
  const [dropTop, setDropTop] = useState<number | null>(null);
  const [limit, setLimit] = useState(view.limit);
  const justDragged = useRef(false);
  useEffect(() => setLimit(view.limit), [view.limit]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let top = 0;
    const push = (item: { kind: Item["kind"]; h: number; [k: string]: unknown }) => {
      out.push({ ...item, top } as unknown as Item);
      top += item.h;
    };
    if (result.groups) {
      for (const g of result.groups) {
        if (g.hidden) continue;
        push({ kind: "group", group: g, h: HEAD });
        if (g.collapsed) continue;
        for (const row of g.rows) push({ kind: "row", row, group: g.key, h: ROW });
        push({ kind: "new", group: g, h: ROW });
      }
    } else {
      for (const row of result.rows.slice(0, limit)) push({ kind: "row", row, group: "", h: ROW });
      push({ kind: "new", group: null, h: ROW });
    }
    return { list: out, height: top };
  }, [result, limit]);

  const keyed = useRef<{ items: typeof items; keys: Set<string>; fresh: Set<string> } | null>(null);
  if (keyed.current?.items !== items) {
    const keys = new Set(items.list.flatMap((it) => (it.kind === "row" ? [`${it.group}:${it.row.id}`] : [])));
    const before = keyed.current?.keys;
    keyed.current = { items, keys, fresh: before ? new Set([...keys].filter((k) => !before.has(k))) : new Set() };
  }
  useFlip(ref, ".db-list-row[data-flip]", "data-flip", [items], { enter: (el) => !!keyed.current?.fresh.has(el.dataset.flip ?? ""), skip: !!drag });
  const leave = useLeaveRef<HTMLDivElement>((el) => !keyed.current?.keys.has(el.dataset.flip ?? ""), "is-row-leaving", MOTION.base);
  const vp = useViewport(ref, [items.height]);
  const from = vp.top - 400;
  const to = vp.bottom + 400;
  const visible = items.list.filter((it) => it.top + it.h >= from && it.top <= to);

  const onRowDown = (e: React.PointerEvent<HTMLDivElement>, row: PageMeta, group: string) => {
    if (e.button !== 0 || view.sorts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const oy = e.clientY - r.top;
    let target: { after: string | null; top: number } | null = null;
    startDrag(e, {
      onStart: () => setDrag({ row, x: r.left, y: r.top, w: r.width, oy }),
      onMove: (ev) => {
        setDrag((d) => (d ? { ...d, y: ev.clientY - d.oy } : d));
        const base = ref.current!.getBoundingClientRect().top;
        const y = ev.clientY - base;
        const rows = items.list.filter((it): it is Extract<Item, { kind: "row" }> => it.kind === "row" && it.group === group);
        let best: { after: string | null; top: number } | null = null;
        for (let i = 0; i <= rows.length; i++) {
          const lineTop = i < rows.length ? rows[i]!.top : rows.length ? rows[rows.length - 1]!.top + ROW : 0;
          if (!best || Math.abs(y - lineTop) < Math.abs(y - best.top)) {
            const prev = i > 0 ? rows[i - 1]!.row.id : null;
            best = { after: prev, top: lineTop };
          }
        }
        if (best && best.after === null && rows[0]) {
          const all = result.rows;
          const idx = all.findIndex((x) => x.id === rows[0]!.row.id);
          best = { after: idx > 0 ? all[idx - 1]!.id : null, top: best.top };
        }
        target = best;
        setDropTop(best?.top ?? null);
      },
      onEnd: (_ev, moved) => {
        setDrag(null);
        setDropTop(null);
        if (moved) {
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 0);
        }
        if (moved && target && target.after !== row.id) actions.moveRow(row.id, target.after);
      },
    });
  };

  return (
    <div className="db-list" ref={ref} data-testid="db-list" style={{ height: items.height + (result.groups ? 0 : result.rows.length > limit ? 34 : 0) }}>
      {visible.map((it) => {
        if (it.kind === "group")
          return (
            <div key={`g:${it.group.key}`} className="db-list-group" data-testid="db-list-group" data-group={it.group.key} style={{ top: it.top }} onClick={() => setGroupState(m.doc, view.id, it.group.key, { collapsed: !it.group.collapsed })}>
              <Icon name={it.group.collapsed ? "chevronRight" : "chevronDown"} size={14} />
              <GroupLabel group={it.group} />
              <span className="db-count">{it.group.rows.length}</span>
              <span className="db-list-group-line" />
            </div>
          );
        if (it.kind === "new")
          return (
            <button
              key={`n:${it.group?.key ?? ""}`}
              type="button"
              className="db-list-new"
              data-testid="db-list-new"
              style={{ top: it.top }}
              onClick={() => void props.newRow({ ...(it.group && view.groupBy ? { group: { prop: view.groupBy.prop, key: it.group.key } } : {}), open: true })}
            >
              <Icon name="plus" size={14} /> New page
            </button>
          );
        const row = it.row;
        return (
          <div
            key={`r:${it.group}:${row.id}`}
            ref={leave}
            data-flip={`${it.group}:${row.id}`}
            className={`db-list-row ${drag?.row.id === row.id ? "is-dragging" : ""}`}
            data-testid="db-list-row"
            data-row={row.id}
            style={{ top: it.top }}
            onPointerDown={(e) => onRowDown(e, row, it.group)}
            onClick={() => !justDragged.current && props.openRow(row.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.openRowMenu(row, { x: e.clientX, y: e.clientY });
            }}
          >
            <span className="db-list-title">
              {view.showIcons && (row.icon ? <RowIcon m={m} row={row} /> : <Icon name="page" size={16} style={{ color: "var(--n-icon)" }} />)}
              <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
            </span>
            <span className="db-list-props">
              {shown.map((p) =>
                isEmptyCell(m, row, p) ? null : (
                  <span key={p.id} className="db-list-prop" data-prop={p.id}>
                    <CellView m={m} row={row} prop={p} />
                  </span>
                ),
              )}
            </span>
          </div>
        );
      })}
      {!result.groups && result.rows.length > limit && (
        <button type="button" className="db-list-new" style={{ top: items.height }} onClick={() => setLimit((l) => l + view.limit)}>
          <Icon name="arrowDown" size={14} /> Load more
        </button>
      )}
      {dropTop !== null && <div className="db-drop-line" style={{ top: dropTop - 1, left: 0, right: 0, height: 2 }} />}
      {drag && (
        <DragGhost x={drag.x} y={drag.y} width={drag.w}>
          <div className="db-list-ghost">
            <RowIcon m={m} row={drag.row} />
            {drag.row.title || "Untitled"}
          </div>
        </DragGhost>
      )}
    </div>
  );
}
