import { useMemo, useRef, useState } from "react";
import type { PageMeta } from "../../../shared/model";
import { setGroupState, TITLE, type Group } from "../../../shared/database";
import { registerCss } from "../styles";
import { Icon } from "../icons";
import { CellView, RowIcon, isEmptyCell } from "../cells";
import { CardPreview, GroupLabel, cardProps, previewRef } from "./board";
import type { ViewProps } from "./types";
import { MOTION, useFlip, useLeaveRef } from "../../ui/motion";

registerCss(
  "gallery",
  `
.db-gallery { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; }
.db-gallery-grid { display: grid; gap: 16px; padding: 4px 0; }
.db-gallery-card { background: var(--n-raised); box-shadow: inset 0 0 0 1px var(--n-group-border); border-radius: var(--n-r-panel, 12px); overflow: hidden; cursor: default; user-select: none; display: flex; flex-direction: column; min-width: 0; }
.db-gallery-card:hover { background: linear-gradient(var(--n-hover), var(--n-hover)), var(--n-raised); }
.db-gallery-preview { width: 100%; background: var(--n-raised); border-bottom: 0.5px solid var(--n-divider); display: flex; align-items: center; justify-content: center; overflow: hidden; flex: none; }
.db-gallery-preview .db-card-preview { height: 100% !important; }
.db-gallery-content { width: 100%; height: 100%; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.db-gallery-content span { height: 6px; border-radius: 3px; background: var(--n-chip); display: block; }
.db-gallery-content .db-row-icon { height: auto; background: none; font-size: 26px; }
.db-gallery-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.db-gallery-title { font-weight: 500; font-size: var(--n-t-body, 13px); display: flex; gap: 6px; align-items: center; min-width: 0; }
.db-gallery-title > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-gallery-prop { font-size: 13px; display: flex; min-width: 0; overflow: hidden; }
.db-gallery-new { border: none; background: transparent; border-radius: var(--n-r-panel, 12px); color: var(--n-text-3); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: var(--n-t-body, 13px); cursor: default; box-shadow: inset 0 0 0 1px var(--n-group-border); }
.db-gallery-new:hover { background: var(--n-hover); color: var(--n-text-2); }
.db-gallery-group { display: flex; align-items: center; gap: 6px; height: 40px; cursor: default; user-select: none; }
.db-gallery-group .db-count { color: var(--n-text-3); }
.db-gallery-more { align-self: flex-start; }
`,
);

const MIN_WIDTH = { small: 180, medium: 260, large: 340 } as const;
const PREVIEW = { small: 120, medium: 160, large: 200 } as const;

export function GalleryView(props: ViewProps) {
  const { m, view, result } = props;
  const shown = useMemo(() => cardProps(m, view), [m.schema, view]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const minWidth = MIN_WIDTH[view.cardSize] ?? 260;
  const previewHeight = PREVIEW[view.cardSize] ?? 160;
  const titleVisible = view.props[TITLE]?.visible !== false;
  const hasPreview = view.cardPreview !== "none" && (view.cardPreview !== "cover" || result.rows.some((row) => !!previewRef(m, view, row)));
  const box = useRef<HTMLDivElement>(null);
  const shownKeys = new Set<string>();
  const keyed = useRef<{ keys: Set<string>; fresh: Set<string> } | null>(null);
  const leave = useLeaveRef<HTMLDivElement>((el) => !keyed.current?.keys.has(el.dataset.flip ?? ""), "is-row-leaving", MOTION.base);

  const renderCard = (row: PageMeta, group: string) => {
    shownKeys.add(`${group}:${row.id}`);
    return (
    <div
      key={row.id}
      ref={leave}
      data-flip={`${group}:${row.id}`}
      className="db-gallery-card"
      data-testid="db-gallery-card"
      data-row={row.id}
      onClick={() => props.openRow(row.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.openRowMenu(row, { x: e.clientX, y: e.clientY });
      }}
    >
      {hasPreview && (
        <div className="db-gallery-preview" style={{ height: previewHeight }}>
          {view.cardPreview === "content" || !previewRef(m, view, row) ? (
            <div className="db-gallery-content">
              {row.icon ? <RowIcon m={m} row={row} size={28} /> : null}
              <span style={{ width: "70%" }} />
              <span style={{ width: "90%" }} />
              <span style={{ width: "55%" }} />
            </div>
          ) : (
            <CardPreview m={m} view={view} row={row} height={previewHeight} />
          )}
        </div>
      )}
      <div className="db-gallery-body">
        {(titleVisible || !shown.length) && (
          <div className="db-gallery-title">
            {view.showIcons && <RowIcon m={m} row={row} />}
            <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
          </div>
        )}
        {shown.map((p) =>
          isEmptyCell(m, row, p) ? null : (
            <div key={p.id} className="db-gallery-prop" data-prop={p.id}>
              <CellView m={m} row={row} prop={p} card wrap />
            </div>
          ),
        )}
      </div>
    </div>
    );
  };

  const renderGrid = (rows: PageMeta[], group: Group | null) => {
    const key = group?.key ?? "";
    const limit = limits[key] ?? view.limit;
    return (
      <>
        <div className="db-gallery-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }}>
          {rows.slice(0, limit).map((row) => renderCard(row, key))}
          <button
            type="button"
            className="db-gallery-new"
            data-testid="db-gallery-new"
            style={{ minHeight: (hasPreview ? previewHeight : 0) + 40 }}
            onClick={() => void props.newRow({ ...(group && view.groupBy ? { group: { prop: view.groupBy.prop, key: group.key } } : {}), open: true })}
          >
            <Icon name="plus" size={14} /> New
          </button>
        </div>
        {rows.length > limit && (
          <button type="button" className="db-btn db-gallery-more" onClick={() => setLimits((l) => ({ ...l, [key]: limit + view.limit }))}>
            <Icon name="arrowDown" size={14} /> Load more
          </button>
        )}
      </>
    );
  };

  const body = result.groups
        ? result.groups
            .filter((g) => !g.hidden)
            .map((g) => (
              <section key={g.key} data-testid="db-gallery-group" data-group={g.key}>
                <div className="db-gallery-group" onClick={() => setGroupState(m.doc, view.id, g.key, { collapsed: !g.collapsed })}>
                  <Icon name={g.collapsed ? "chevronRight" : "chevronDown"} size={14} />
                  <GroupLabel group={g} />
                  <span className="db-count">{g.rows.length}</span>
                </div>
                {!g.collapsed && renderGrid(g.rows, g)}
              </section>
            ))
        : renderGrid(result.rows, null);
  const shownList = [...shownKeys].join();
  if (!keyed.current) keyed.current = { keys: shownKeys, fresh: new Set() };
  else if (shownList !== [...keyed.current.keys].join()) {
    const before = keyed.current.keys;
    keyed.current = { keys: shownKeys, fresh: new Set([...shownKeys].filter((k) => !before.has(k))) };
  }
  useFlip(box, ".db-gallery-card[data-flip]", "data-flip", [shownList], { enter: (el) => !!keyed.current?.fresh.has(el.dataset.flip ?? "") });
  return (
    <div className="db-gallery" data-testid="db-gallery" ref={box}>
      {body}
    </div>
  );
}
