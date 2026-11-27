import { useMemo, useRef, useState, type ReactNode } from "react";
import type { PageMeta } from "../../../shared/model";
import {
  filesValue,
  groupRows,
  isVisible,
  setGroupState,
  TITLE,
  viewProperties,
  NONE,
  type Group,
  type Property,
  type View,
} from "../../../shared/database";
import { registerCss } from "../styles";
import { Icon } from "../icons";
import { CellView, RowIcon, isEmptyCell, useFileUrl } from "../cells";
import { Avatar, DragGhost, Menu, MenuItem, Popover, StatusDot, Tag, startDrag, usePopover } from "../ui";
import type { DatabaseModel } from "../data";
import type { ViewProps } from "./types";
import { exitRef, useFlip } from "../../ui/motion";

const cardExit = exitRef<HTMLDivElement>("is-row-leaving", 140);

registerCss(
  "board",
  `
.db-board { display: flex; flex-direction: column; gap: 4px; overflow-x: auto; padding-bottom: 12px; min-height: 200px; }
.db-page.is-full .db-board { margin-right: calc(-1 * var(--db-gutter)); padding-right: var(--db-gutter); }
.db-board-lane { display: flex; flex-direction: column; }
.db-board-lane-head { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 4px; font-size: var(--n-t-body, 13px); font-weight: 500; position: sticky; left: 0; width: max-content; }
.db-board-lane-head .db-count { color: var(--n-text-3); font-weight: 400; }
.db-board-cols { display: flex; gap: 12px; align-items: flex-start; }
.db-board-column { flex: none; display: flex; flex-direction: column; border-radius: var(--n-r-tile, 8px); padding: 0 6px 6px; position: relative; }
.db-board-column.is-drop { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--n-form-accent) 45%, transparent); }
.db-board-head { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 2px; flex: none; }
.db-board-head .db-count { color: var(--n-text-3); font-size: var(--n-t-body, 13px); font-variant-numeric: tabular-nums; }
.db-board-head .db-spacer { flex: 1; }
.db-board-head .db-icon-btn { opacity: 0; }
.db-board-column:hover .db-board-head .db-icon-btn { opacity: 1; }
.db-board-cards { display: flex; flex-direction: column; gap: 8px; position: relative; min-height: 8px; }
.db-card { position: relative; background: var(--n-raised); box-shadow: inset 0 0 0 1px var(--n-group-border); border-radius: var(--n-r-tile, 8px); overflow: hidden; cursor: default; user-select: none; }
.db-card:hover { background: linear-gradient(var(--n-hover), var(--n-hover)), var(--n-raised); }
.db-card.is-dragging { opacity: .35; }
.db-card-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.db-card-title { font-weight: 500; font-size: var(--n-t-body, 13px); display: flex; gap: 6px; align-items: flex-start; word-break: break-word; }
.db-card-title .db-row-icon { margin-top: 1px; }
.db-card-prop { font-size: 13px; min-width: 0; display: flex; }
.db-card-prop .db-cell-value { min-width: 0; overflow: hidden; }
.db-card-more { position: absolute; top: 6px; right: 6px; opacity: 0; background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); box-shadow: var(--n-glass-edge); }
.db-card:hover .db-card-more { opacity: 1; }
.db-card-preview { width: 100%; background: var(--n-raised); display: block; overflow: hidden; }
.db-card-preview img { width: 100%; height: 100%; display: block; object-fit: cover; }
.db-card-preview.is-fit img { object-fit: contain; }
.db-card-input { width: 100%; border: none; outline: none; background: transparent; font: inherit; font-weight: 500; font-size: var(--n-t-body, 13px); color: var(--n-text); padding: 0; }
.db-board-new { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border: none; background: transparent; border-radius: 4px; color: var(--n-text-2); font-size: var(--n-t-body, 13px); cursor: default; width: 100%; text-align: left; }
.db-board-new:hover { background: var(--n-hover); }
.db-board-more-btn { color: var(--n-text-2); }
.db-board-collapsed { flex: none; width: 44px; border-radius: var(--n-r-tile, 8px); display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 8px; cursor: default; }
.db-board-collapsed:hover { background: var(--n-hover); }
.db-board-collapsed .db-vertical { writing-mode: vertical-rl; display: flex; align-items: center; gap: 6px; }
.db-board-hidden { flex: none; width: 220px; padding: 0 6px; }
.db-board-hidden-head { height: 40px; display: flex; align-items: center; color: var(--n-text-2); font-size: var(--n-t-body, 13px); padding: 0 2px; }
.db-board-hidden-item { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 6px; border-radius: 4px; cursor: default; }
.db-board-hidden-item:hover { background: var(--n-hover); }
.db-board-hidden-item .db-count { color: var(--n-text-3); margin-left: auto; font-size: 13px; }
.db-card-slot { border-radius: var(--n-r-tile, 8px); background: color-mix(in srgb, var(--n-form-accent) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--n-form-accent) 40%, transparent); flex: none; }
.db-group-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--n-t-body, 13px); }
`,
);

export const CARD_WIDTH = { small: 220, medium: 260, large: 320 } as const;
const PREVIEW_HEIGHT = { small: 100, medium: 140, large: 180 } as const;

export function previewRef(m: DatabaseModel, view: View, row: PageMeta): string | null {
  if (view.cardPreview === "none" || view.cardPreview === "content") return null;
  if (view.cardPreview === "cover") return row.cover.startsWith("file:") || /^https?:\/\//.test(row.cover) ? row.cover : null;
  const prop = m.schema.find((p) => p.id === view.cardPreview && p.type === "files");
  if (!prop) return null;
  const file = filesValue(row, prop).find((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(f.ref));
  return file?.ref ?? null;
}

export function CardPreview({ m, view, row, height }: { m: DatabaseModel; view: View; row: PageMeta; height: number }) {
  const ref = previewRef(m, view, row);
  const url = useFileUrl(m, ref);
  if (!ref) return null;
  return <span className={`db-card-preview ${view.fitImage ? "is-fit" : ""}`} style={{ height }}>{url && <img src={url} alt="" draggable={false} />}</span>;
}

export function cardProps(m: DatabaseModel, view: View): Property[] {
  return viewProperties(view, m.schema).filter((p) => p.id !== TITLE && isVisible(view, p));
}

export function GroupLabel({ group }: { m?: DatabaseModel; group: Group }) {
  if (group.person) return (
    <span className="db-group-label">
      <Avatar name={group.person.name} color={group.person.color} size={18} />
      <span>{group.person.name}</span>
    </span>
  );
  if (group.empty) return <span className="db-group-label" style={{ color: "var(--n-text-2)" }}>{group.label}</span>;
  if (group.option || group.color !== "default" || ["todo", "doing", "done"].includes(group.key)) {
    const status = group.option?.group !== undefined || ["todo", "doing", "done"].includes(group.key);
    return (
      <Tag color={group.color} className={status ? "db-status-tag" : ""}>
        {status && <StatusDot color={group.color} />}
        {group.label}
      </Tag>
    );
  }
  if (group.key === "true" || group.key === "false") return (
    <span className="db-group-label">
      <span className={`db-check ${group.key === "true" ? "is-on" : ""}`}>{group.key === "true" && <Icon name="check" size={12} strokeWidth={2} />}</span>
      {group.label}
    </span>
  );
  return <span className="db-group-label">{group.label || "Untitled"}</span>;
}

type DragInfo = { row: PageMeta; from: string; lane: string; x: number; y: number; w: number; h: number; ox: number; oy: number };
type DropInfo = { lane: string; group: string; index: number };

export function Card({
  m,
  view,
  row,
  props,
  width,
  onPointerDown,
  dragging,
  editing,
  onEditDone,
  testId = "db-card",
  previewHeight,
  onOpen,
  onMenu,
}: {
  m: DatabaseModel;
  view: View;
  row: PageMeta;
  props: Property[];
  width?: number;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  dragging?: boolean;
  editing?: boolean;
  onEditDone?: (text: string | null) => void;
  testId?: string;
  previewHeight: number;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement | { x: number; y: number }) => void;
}) {
  const [text, setText] = useState("");
  const titleVisible = view.props[TITLE]?.visible !== false;
  return (
    <div
      ref={cardExit}
      className={`db-card ${dragging ? "is-dragging" : ""}`}
      data-testid={testId}
      data-row={row.id}
      style={width ? { width } : undefined}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".db-card-more,input")) return;
        if (!editing) onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <CardPreview m={m} view={view} row={row} height={previewHeight} />
      <div className="db-card-body">
        {editing ? (
          <input
            className="db-card-input"
            autoFocus
            data-testid="db-card-title-input"
            value={text}
            placeholder="Type a name…"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => onEditDone?.(text)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEditDone?.(text);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onEditDone?.(null);
              }
            }}
          />
        ) : (
          (titleVisible || props.length === 0) && (
            <div className="db-card-title">
              {view.showIcons && <RowIcon m={m} row={row} />}
              <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
            </div>
          )
        )}
        {props.map((p) =>
          isEmptyCell(m, row, p) ? null : (
            <div key={p.id} className="db-card-prop" data-prop={p.id}>
              <CellView m={m} row={row} prop={p} card wrap />
            </div>
          ),
        )}
      </div>
      <button
        type="button"
        className="db-icon-btn db-card-more"
        aria-label="Card actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e.currentTarget);
        }}
      >
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}

function groupsOf(m: DatabaseModel, view: View, rows: PageMeta[], fallback: Group[] | null): Group[] {
  if (!view.groupBy) return [{ key: "all", label: "All", color: "default", rows, empty: false, hidden: false, collapsed: false }];
  if (fallback) return fallback;
  return groupRows(m.ctx, rows, view.groupBy, view.groups);
}

export function BoardView(props: ViewProps) {
  const { m, actions, view, result, editable } = props;
  const width = CARD_WIDTH[view.cardSize] ?? 260;
  const previewHeight = PREVIEW_HEIGHT[view.cardSize] ?? 140;
  const shown = useMemo(() => cardProps(m, view), [m.schema, view]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [drop, setDrop] = useState<DropInfo | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>({});
  const groupMenu = usePopover<{ group: Group }>();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const justDragged = useRef(false);
  useFlip(boardRef, ".db-card[data-row]", "data-row", [result, collapsedLanes], { enter: true });
  const groupProp = view.groupBy ? m.schema.find((p) => p.id === view.groupBy!.prop) : undefined;
  const canMoveGroups = !!groupProp && !["formula", "rollup", "created_time", "created_by", "edited_time", "edited_by", "id", "title"].includes(groupProp.type);

  const lanes = useMemo(() => {
    if (!view.subGroupBy) return [{ key: "", label: "", group: null as Group | null, groups: groupsOf(m, view, result.rows, result.groups) }];
    const subs = groupRows(m.ctx, result.rows, view.subGroupBy, view.subGroups).filter((g) => !g.hidden && (g.rows.length > 0 || !g.empty));
    return subs.map((sg) => ({ key: sg.key, label: sg.label, group: sg as Group | null, groups: groupsOf(m, view, sg.rows, null) }));
  }, [m.ctx, view, result]);

  const allGroups = lanes[0]?.groups ?? [];
  const hiddenGroups = allGroups.filter((g) => g.hidden);

  const onCardDown = (e: React.PointerEvent<HTMLDivElement>, row: PageMeta, group: string, lane: string) => {
    if (e.button !== 0 || editingRow) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const ox = e.clientX - r.left;
    const oy = e.clientY - r.top;
    let current: DropInfo | null = null;
    startDrag(e, {
      onStart: () => setDrag({ row, from: group, lane, x: r.left, y: r.top, w: r.width, h: r.height, ox, oy }),
      onMove: (ev) => {
        edgeScroll(ev.clientX);
        setDrag((d) => (d ? { ...d, x: ev.clientX - d.ox, y: ev.clientY - d.oy } : d));
        current = hitTest(ev.clientX, ev.clientY, row.id);
        setDrop(current);
      },
      onEnd: (_ev, moved) => {
        setDrag(null);
        setDrop(null);
        if (moved) {
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 0);
        }
        if (!moved || !current) return;
        commitDrop(row, group, lane, current);
      },
    });
  };

  const edgeScroll = (x: number) => {
    const board = boardRef.current;
    if (!board || board.scrollWidth <= board.clientWidth) return;
    const r = board.getBoundingClientRect();
    const edge = 48;
    if (x < r.left + edge) board.scrollLeft -= Math.ceil((r.left + edge - x) / 3);
    else if (x > r.right - edge) board.scrollLeft += Math.ceil((x - (r.right - edge)) / 3);
  };

  const hitTest = (x: number, y: number, dragged: string): DropInfo | null => {
    const root = boardRef.current;
    if (!root) return null;
    const cols = [...root.querySelectorAll<HTMLElement>("[data-testid=db-board-column]")];
    for (const col of cols) {
      const r = col.getBoundingClientRect();
      const lane = (col.closest(".db-board-lane") ?? root).getBoundingClientRect();
      if (x < r.left - 6 || x > r.right + 6 || y < Math.min(r.top, lane.top) - 6 || y > Math.max(r.bottom + 40, lane.bottom)) continue;
      const cards = [...col.querySelectorAll<HTMLElement>("[data-testid=db-card]")].filter((c) => c.dataset.row !== dragged);
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const cr = cards[i]!.getBoundingClientRect();
        if (y < cr.top + cr.height / 2) {
          index = i;
          break;
        }
      }
      return { lane: col.dataset.lane ?? "", group: col.dataset.group ?? "", index };
    }
    return null;
  };

  const commitDrop = (row: PageMeta, from: string, fromLane: string, target: DropInfo) => {
    const lane = lanes.find((l) => l.key === target.lane);
    const group = lane?.groups.find((g) => g.key === target.group);
    if (!group) return;
    m.tree.transact(() => {
      if (view.groupBy && target.group !== from && canMoveGroups) actions.moveToGroup(row, view.groupBy.prop, from, target.group);
      if (view.subGroupBy && target.lane !== fromLane) {
        const sp = m.schema.find((p) => p.id === view.subGroupBy!.prop);
        if (sp) actions.moveToGroup(m.store.pages.get(row.id) ?? row, sp.id, fromLane, target.lane);
      }
      if (!view.sorts.length) {
        const cards = group.rows.filter((r) => r.id !== row.id);
        const all = result.rows.filter((r) => r.id !== row.id);
        let after: string | null;
        if (target.index > 0) after = cards[target.index - 1]?.id ?? null;
        else {
          const first = cards[0];
          const i = first ? all.findIndex((r) => r.id === first.id) : -1;
          after = i > 0 ? all[i - 1]!.id : i === 0 ? null : all.at(-1)?.id ?? null;
        }
        if (after !== row.id) actions.moveRow(row.id, after);
      }
    });
  };

  const addCard = async (group: Group, lane: string) => {
    const input: Parameters<typeof props.newRow>[0] = { open: false };
    if (view.groupBy && group.key !== "all") input.group = { prop: view.groupBy.prop, key: group.key };
    const id = await props.newRow(input);
    if (view.subGroupBy && lane) {
      const sp = m.schema.find((p) => p.id === view.subGroupBy!.prop);
      const row = m.store.pages.get(id);
      if (sp && row) actions.moveToGroup(row, sp.id, NONE, lane);
    }
    setEditingRow(id);
  };

  const finishEdit = (id: string, text: string | null) => {
    setEditingRow(null);
    if (text === null) return;
    const title = m.schema.find((p) => p.id === TITLE)!;
    if (text.trim()) actions.setValue(id, title, text.trim());
  };

  const renderColumn = (group: Group, lane: string): ReactNode => {
    if (group.collapsed)
      return (
        <div key={group.key} className={`db-board-collapsed ${view.colorColumns ? `db-group-tint c-${group.color}` : ""}`} data-testid="db-board-collapsed" data-group={group.key} onClick={() => setGroupState(m.doc, view.id, group.key, { collapsed: false })}>
          <span className="db-vertical">
            <GroupLabel m={m} group={group} />
            <span className="db-count" style={{ color: "var(--n-text-3)" }}>{group.rows.length}</span>
          </span>
        </div>
      );
    const limit = limits[`${lane}|${group.key}`] ?? view.limit;
    const visible = group.rows.slice(0, limit);
    const isDrop = drop && drop.group === group.key && drop.lane === lane;
    return (
      <div key={group.key} className={`db-board-column ${view.colorColumns ? `db-group-tint c-${group.color}` : ""} ${isDrop ? "is-drop" : ""}`} data-testid="db-board-column" data-group={group.key} data-lane={lane} style={{ width: width + 12 }}>
        <div className="db-board-head">
          <GroupLabel m={m} group={group} />
          <span className="db-count">{group.rows.length}</span>
          <span className="db-spacer" />
          {view.groupBy && (
            <button type="button" className="db-icon-btn" aria-label="Group actions" data-testid="db-board-group-more" onClick={(e) => groupMenu.open(e.currentTarget, { group })}>
              <Icon name="more" size={14} />
            </button>
          )}
          <button type="button" className="db-icon-btn" aria-label="New" data-testid="db-board-add" onClick={() => void addCard(group, lane)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="db-board-cards">
          {visible.map((row, i) => (
            <FragmentSlot key={row.id} show={!!isDrop && drop!.index === indexWithout(visible, i, drag?.row.id)} height={drag?.h ?? 0} skip={drag?.row.id === row.id}>
              <Card
                m={m}
                view={view}
                row={row}
                props={shown}
                previewHeight={previewHeight}
                dragging={drag?.row.id === row.id}
                editing={editingRow === row.id}
                onEditDone={(t) => finishEdit(row.id, t)}
                onPointerDown={(e) => onCardDown(e, row, group.key, lane)}
                onOpen={() => !justDragged.current && props.openRow(row.id)}
                onMenu={(a) => props.openRowMenu(row, a)}
              />
            </FragmentSlot>
          ))}
          {isDrop && drop!.index >= visible.filter((r) => r.id !== drag?.row.id).length && <div className="db-card-slot" style={{ height: drag?.h ?? 40 }} />}
        </div>
        {group.rows.length > limit && (
          <button type="button" className="db-board-new db-board-more-btn" onClick={() => setLimits((l) => ({ ...l, [`${lane}|${group.key}`]: limit + view.limit }))}>
            <Icon name="arrowDown" size={14} /> Load more
          </button>
        )}
        <button type="button" className="db-board-new" data-testid="db-board-new" onClick={() => void addCard(group, lane)}>
          <Icon name="plus" size={14} /> New
        </button>
      </div>
    );
  };

  return (
    <div className="db-board" ref={boardRef} data-testid="db-board">
      {lanes.map((lane) => (
        <div key={lane.key || "main"} className="db-board-lane" data-testid={lane.group ? "db-board-lane" : undefined} data-lane={lane.key}>
          {lane.group && (
            <div className="db-board-lane-head" onClick={() => setCollapsedLanes((c) => ({ ...c, [lane.key]: !c[lane.key] }))}>
              <Icon name={collapsedLanes[lane.key] ? "chevronRight" : "chevronDown"} size={14} />
              <GroupLabel m={m} group={lane.group} />
              <span className="db-count">{lane.group.rows.length}</span>
            </div>
          )}
          {!collapsedLanes[lane.key] && (
            <div className="db-board-cols">
              {lane.groups.filter((g) => !g.hidden).map((g) => renderColumn(g, lane.key))}
              {!lane.group && hiddenGroups.length > 0 && (
                <div className="db-board-hidden" data-testid="db-board-hidden">
                  <div className="db-board-hidden-head">Hidden groups</div>
                  {hiddenGroups.map((g) => (
                    <div
                      key={g.key}
                      className="db-board-hidden-item"
                      data-testid="db-board-hidden-item"
                      data-group={g.key}
                      title={editable ? "Show group" : undefined}
                      onClick={() => editable && setGroupState(m.doc, view.id, g.key, { hidden: false })}
                    >
                      <GroupLabel m={m} group={g} />
                      <span className="db-count">{g.rows.length}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {drag && (
        <DragGhost x={drag.x} y={drag.y} width={drag.w}>
          <Card m={m} view={view} row={drag.row} props={shown} previewHeight={previewHeight} onOpen={() => {}} onMenu={() => {}} />
        </DragGhost>
      )}
      {groupMenu.state && (
        <Popover anchor={groupMenu.state.anchor} onClose={groupMenu.close} width={200}>
          <Menu>
            {editable && (
              <MenuItem
                icon="eyeOff"
                label="Hide group"
                testId="db-board-hide-group"
                onSelect={() => {
                  setGroupState(m.doc, view.id, groupMenu.state!.value.group.key, { hidden: true });
                  groupMenu.close();
                }}
              />
            )}
            <MenuItem
              icon="chevronLeft"
              label="Collapse group"
              testId="db-board-collapse-group"
              onSelect={() => {
                setGroupState(m.doc, view.id, groupMenu.state!.value.group.key, { collapsed: true });
                groupMenu.close();
              }}
            />
          </Menu>
        </Popover>
      )}
    </div>
  );
}

function indexWithout(rows: PageMeta[], i: number, dragged: string | undefined) {
  let n = 0;
  for (let j = 0; j < i; j++) if (rows[j]!.id !== dragged) n++;
  return n;
}

function FragmentSlot({ show, height, skip, children }: { show: boolean; height: number; skip: boolean; children: ReactNode }) {
  return (
    <>
      {show && !skip && <div className="db-card-slot" style={{ height }} />}
      {children}
    </>
  );
}
