import { useRef, useState } from "react";
import {
  TITLE,
  VIEW_TYPES,
  isVisible,
  moveViewProp,
  setGroupState,
  setViewProp,
  updateSettings,
  updateView,
  viewProperties,
  countFilterRules,
  groupRows,
  type GroupBy,
  type Property,
  type View,
  type ViewType,
} from "../../shared/database";
import type { DatabaseModel } from "./data";
import type { Actions } from "./actions";
import { Icon, TypeIcon, ViewIcon } from "./icons";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, Segmented, Toggle, type Anchor } from "./ui";
import { GroupLabel } from "./views/board";
import { AddPropertyMenu } from "./views/table";
import { registerCss } from "./styles";

type Page = "main" | "layout" | "properties" | "group" | "subgroup" | "limit" | "openAs" | "add";

const DATE_TYPES = ["date", "created_time", "edited_time", "formula", "rollup"];
const GROUPABLE = ["select", "multi_select", "status", "person", "checkbox", "date", "text", "number", "url", "email", "phone", "relation", "formula", "created_by", "edited_by", "created_time", "edited_time", "id", "title"];

export function ViewSettings({ m, actions, view, anchor, onClose, onOpenFilter, onOpenSort, initial = "main" }: { m: DatabaseModel; actions: Actions; view: View; anchor: Anchor; onClose: () => void; onOpenFilter: () => void; onOpenSort: () => void; initial?: Page }) {
  const [page, setPage] = useState<Page>(initial);
  const [name, setName] = useState(view.name);
  const set = (patch: Parameters<typeof updateView>[2]) => updateView(m.doc, view.id, patch);
  const locked = m.locked;
  const head = (title: string, back: Page = "main") => (
    <div className="db-panel-head">
      <button type="button" className="db-icon-btn" aria-label="Back" data-testid="db-settings-back" onClick={() => setPage(back)}>
        <Icon name="arrowLeft" size={14} />
      </button>
      <span>{title}</span>
      <span className="db-flex" />
      <button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
  const propName = (id: string) => m.schema.find((p) => p.id === id)?.name ?? "None";
  let body: React.ReactNode;
  if (page === "layout") body = <LayoutPage m={m} view={view} set={set} head={head("Layout")} />;
  else if (page === "properties") body = <PropertiesPage m={m} view={view} head={head("Properties")} onAdd={() => setPage("add")} />;
  else if (page === "add")
    body = (
      <>
        {head("New property", "properties")}
        <AddPropertyMenu onPick={(type) => {
          actions.newProperty(type, { view });
          setPage("properties");
        }} />
      </>
    );
  else if (page === "group" || page === "subgroup") body = <GroupPage m={m} view={view} sub={page === "subgroup"} head={head(page === "group" ? "Group" : "Sub-group")} />;
  else if (page === "limit")
    body = (
      <>
        {head("Load limit")}
        <Menu>
          {[10, 25, 50, 100, 500, 10000].map((n) => (
            <MenuItem key={n} label={n === 10000 ? "All" : `${n} pages`} checked={view.limit === n} testId="db-limit-option" onSelect={() => set({ limit: n })} />
          ))}
        </Menu>
      </>
    );
  else if (page === "openAs")
    body = (
      <>
        {head("Open pages in")}
        <Menu>
          {(
            [
              ["side", "Side peek", "sidePeek"],
              ["center", "Center peek", "centerPeek"],
              ["full", "Full page", "fullPage"],
            ] as const
          ).map(([id, label, icon]) => (
            <MenuItem key={id} icon={icon} label={label} testId={`db-open-as-${id}`} checked={m.settings.openAs === id} onSelect={() => updateSettings(m.doc, { openAs: id })} />
          ))}
        </Menu>
      </>
    );
  else
    body = (
      <Menu autoFocus={false}>
        <div className="db-panel-head">
          <span>View settings</span>
          <span className="db-flex" />
          <button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="db-menu-pad db-prop-name-row">
          <span className="db-prop-type-icon">
            <ViewIcon type={view.type} />
          </span>
          <input className="db-input" value={name} disabled={locked} data-testid="db-view-name" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== view.name && set({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
        <MenuItem icon="layout" label="Layout" right={VIEW_TYPES.find((t) => t.type === view.type)!.label} chevron disabled={locked} testId="db-settings-layout" onSelect={() => setPage("layout")} />
        <MenuItem icon="list" label="Properties" right={`${m.schema.filter((p) => isVisible(view, p)).length} shown`} chevron testId="db-settings-properties" onSelect={() => setPage("properties")} />
        <MenuItem icon="filter" label="Filter" right={countFilterRules(view.filter) ? `${countFilterRules(view.filter)} rules` : "None"} chevron testId="db-settings-filter" onSelect={() => {
          onClose();
          onOpenFilter();
        }} />
        <MenuItem icon="sort" label="Sort" right={view.sorts.length ? `${view.sorts.length} sorts` : "None"} chevron testId="db-settings-sort" onSelect={() => {
          onClose();
          onOpenSort();
        }} />
        {view.type !== "calendar" && view.type !== "chart" && <MenuItem icon="group" label="Group" right={view.groupBy ? propName(view.groupBy.prop) : "None"} chevron testId="db-settings-group" disabled={locked} onSelect={() => setPage("group")} />}
        {view.type === "board" && <MenuItem icon="group" label="Sub-group" right={view.subGroupBy ? propName(view.subGroupBy.prop) : "None"} chevron testId="db-settings-subgroup" disabled={locked} onSelect={() => setPage("subgroup")} />}
        {view.type !== "calendar" && view.type !== "chart" && view.type !== "timeline" && <MenuItem icon="arrowDown" label="Load limit" right={view.limit >= 10000 ? "All" : `${view.limit} pages`} chevron onSelect={() => setPage("limit")} />}
        <MenuSeparator />
        <MenuItem icon={m.settings.openAs === "center" ? "centerPeek" : m.settings.openAs === "full" ? "fullPage" : "sidePeek"} label="Open pages in" right={m.settings.openAs === "side" ? "Side peek" : m.settings.openAs === "center" ? "Center peek" : "Full page"} chevron testId="db-settings-open-as" onSelect={() => setPage("openAs")} />
        <MenuItem icon={locked ? "unlock" : "lock"} label={locked ? "Unlock database" : "Lock database"} testId="db-settings-lock" onSelect={() => updateSettings(m.doc, { locked: !m.settings.locked })} />
        <MenuItem icon="link" label="Copy link to view" onSelect={() => {
          const url = `ardia://notes/${(m.meta?.title || "Untitled").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Untitled"}-${m.page}?v=${view.id}`;
          navigator.clipboard?.writeText(url).catch(() => {});
          onClose();
        }} />
        {!locked && (
          <>
            <MenuItem icon="copy" label="Duplicate view" testId="db-settings-duplicate" onSelect={() => {
              actions.duplicateView(view.id);
              onClose();
            }} />
            <MenuItem icon="trash" label="Delete view" danger disabled={m.views.length <= 1} testId="db-settings-delete" onSelect={() => {
              actions.deleteView(view.id);
              onClose();
            }} />
          </>
        )}
      </Menu>
    );
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" width={290} testId="db-view-settings">
      {body}
    </Popover>
  );
}

function PropSelect({ m, value, onChange, filter, none = "None", testId }: { m: DatabaseModel; value: string; onChange: (v: string) => void; filter: (p: Property) => boolean; none?: string; testId?: string }) {
  return (
    <select className="db-input" value={value} data-testid={testId} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {m.schema.filter(filter).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="db-set-row">
      <span>{label}</span>
      <div className="db-set-ctl">{children}</div>
    </div>
  );
}

function LayoutPage({ m, view, set, head }: { m: DatabaseModel; view: View; set: (patch: Parameters<typeof updateView>[2]) => void; head: React.ReactNode }) {
  const files = (p: Property) => p.type === "files";
  return (
    <div className="db-menu">
      {head}
      <div className="db-layout-grid" data-testid="db-layout-grid">
        {VIEW_TYPES.map((t) => (
          <button type="button" key={t.type} data-testid={`db-layout-${t.type}`} className={`db-layout-tile ${view.type === t.type ? "is-on" : ""}`} onClick={() => switchType(m, view, t.type)}>
            <ViewIcon type={t.type} size={20} />
            {t.label}
          </button>
        ))}
      </div>
      <MenuSeparator />
      {view.type === "table" && (
        <>
          <Row label="Show page icon"><Toggle on={view.showIcons} onChange={(on) => set({ showIcons: on })} /></Row>
          <Row label="Wrap all columns"><Toggle on={view.wrap} testId="db-wrap-toggle" onChange={(on) => set({ wrap: on })} /></Row>
        </>
      )}
      {(view.type === "board" || view.type === "gallery") && (
        <>
          <Row label="Card preview">
            <select className="db-input" value={view.cardPreview} data-testid="db-card-preview" onChange={(e) => set({ cardPreview: e.target.value })}>
              <option value="none">None</option>
              <option value="cover">Page cover</option>
              <option value="content">Page content</option>
              {m.schema.filter(files).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Card size">
            <Segmented value={view.cardSize} testId="db-card-size" options={[{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }]} onChange={(v) => set({ cardSize: v })} />
          </Row>
          <Row label="Fit image"><Toggle on={view.fitImage} onChange={(on) => set({ fitImage: on })} /></Row>
          {view.type === "board" && <Row label="Color columns"><Toggle on={view.colorColumns} onChange={(on) => set({ colorColumns: on })} /></Row>}
        </>
      )}
      {(view.type === "calendar" || view.type === "timeline") && (
        <>
          <Row label={view.type === "calendar" ? "Show calendar by" : "Show timeline by"}>
            <PropSelect m={m} value={view.dateProp} testId="db-date-prop" onChange={(v) => set({ dateProp: v })} filter={(p) => DATE_TYPES.includes(p.type)} />
          </Row>
          {view.type === "timeline" && (
            <>
              <Row label="Separate end date">
                <PropSelect m={m} value={view.endProp} none="Use date range" onChange={(v) => set({ endProp: v })} filter={(p) => p.type === "date" && p.id !== view.dateProp} />
              </Row>
              <Row label="Show table"><Toggle on={view.showTable} onChange={(on) => set({ showTable: on })} /></Row>
              <Row label="Zoom">
                <select className="db-input" value={view.zoom} onChange={(e) => set({ zoom: e.target.value as View["zoom"] })}>
                  {["day", "week", "month", "quarter", "year"].map((z) => (
                    <option key={z} value={z}>
                      {z[0]!.toUpperCase() + z.slice(1)}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}
          {view.type === "calendar" && <Row label="Show weekends"><Toggle on={view.showWeekends} onChange={(on) => set({ showWeekends: on })} /></Row>}
        </>
      )}
      {view.type === "chart" && (
        <>
          <Row label="Chart type">
            <Segmented value={view.chartType} options={[{ id: "bar", label: "Bar" }, { id: "line", label: "Line" }, { id: "donut", label: "Donut" }]} onChange={(v) => set({ chartType: v })} />
          </Row>
          <Row label="X axis">
            <PropSelect m={m} value={view.chartBy} testId="db-chart-by" onChange={(v) => set({ chartBy: v })} filter={(p) => GROUPABLE.includes(p.type)} />
          </Row>
          <Row label="Y axis">
            <select className="db-input" value={view.chartAgg} onChange={(e) => set({ chartAgg: e.target.value as View["chartAgg"] })}>
              <option value="count">Count</option>
              <option value="sum">Sum</option>
              <option value="avg">Average</option>
            </select>
          </Row>
          {view.chartAgg !== "count" && (
            <Row label="Of">
              <PropSelect m={m} value={view.chartValue} onChange={(v) => set({ chartValue: v })} filter={(p) => ["number", "formula", "rollup", "id"].includes(p.type)} />
            </Row>
          )}
        </>
      )}
      <div className="db-menu-pad" />
    </div>
  );
}

export function switchType(m: DatabaseModel, view: View, type: ViewType) {
  const patch: Parameters<typeof updateView>[2] = { type };
  if (view.name === VIEW_TYPES.find((t) => t.type === view.type)!.label) patch.name = VIEW_TYPES.find((t) => t.type === type)!.label;
  if (type === "board" && !view.groupBy) {
    const prop = m.schema.find((p) => p.type === "status") ?? m.schema.find((p) => p.type === "select") ?? m.schema.find((p) => p.type === "multi_select" || p.type === "person" || p.type === "checkbox");
    if (prop) patch.groupBy = { prop: prop.id, date: "relative", text: "exact", status: "option", step: 10, sort: "manual", hideEmpty: false };
  }
  if ((type === "calendar" || type === "timeline") && !view.dateProp) {
    const prop = m.schema.find((p) => p.type === "date") ?? m.schema.find((p) => p.type === "created_time");
    if (prop) patch.dateProp = prop.id;
  }
  if (type === "chart" && !view.chartBy) {
    const prop = m.schema.find((p) => ["status", "select", "multi_select", "person", "checkbox"].includes(p.type));
    if (prop) patch.chartBy = prop.id;
  }
  updateView(m.doc, view.id, patch);
}

function PropertiesPage({ m, view, head, onAdd }: { m: DatabaseModel; view: View; head: React.ReactNode; onAdd: () => void }) {
  const [q, setQ] = useState("");
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  const ordered = viewProperties(view, m.schema);
  const list = ordered.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const shown = list.filter((p) => isVisible(view, p));
  const hidden = list.filter((p) => !isVisible(view, p));
  const titleFixed = view.type === "table" || view.type === "list" || view.type === "timeline";
  const row = (p: Property) => (
    <div
      key={p.id}
      className={`db-item db-propvis ${over?.id === p.id ? (over.before ? "is-over-before" : "is-over-after") : ""}`}
      data-testid="db-propvis"
      data-prop={p.name}
      draggable={!m.locked}
      onDragStart={() => (drag.current = p.id)}
      onDragOver={(e) => {
        if (!drag.current || drag.current === p.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setOver({ id: p.id, before: e.clientY < r.top + r.height / 2 });
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        const from = drag.current;
        drag.current = null;
        setOver(null);
        if (!from || from === p.id) return;
        const r = e.currentTarget.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const others = ordered.filter((x) => x.id !== from);
        const i = others.findIndex((x) => x.id === p.id);
        moveViewProp(m.doc, view, m.schema, from, before ? others[i - 1]?.id ?? null : p.id);
      }}
      onMouseEnter={(e) => e.currentTarget.classList.add("is-active")}
      onMouseLeave={(e) => e.currentTarget.classList.remove("is-active")}
    >
      <span className="db-drag-handle is-visible"><Icon name="drag" size={12} /></span>
      <span className="db-item-icon"><TypeIcon type={p.type} size={16} /></span>
      <span className="db-item-label">{p.name}</span>
      {!(p.id === TITLE && titleFixed) && (
        <button type="button" className="db-icon-btn" data-testid="db-propvis-toggle" aria-label={isVisible(view, p) ? "Hide" : "Show"} onClick={() => setViewProp(m.doc, view.id, p.id, { visible: !isVisible(view, p) })}>
          <Icon name={isVisible(view, p) ? "eye" : "eyeOff"} size={16} />
        </button>
      )}
    </div>
  );
  return (
    <div className="db-menu">
      {head}
      <div className="db-menu-pad">
        <input className="db-input" placeholder="Search for a property…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <MenuLabel right={<button type="button" className="db-link-btn" onClick={() => {
        m.doc.transact(() => {
          for (const p of shown) if (!(p.id === TITLE && titleFixed)) setViewProp(m.doc, view.id, p.id, { visible: false });
        });
      }}>Hide all</button>}>Shown in {view.type}</MenuLabel>
      {shown.map(row)}
      {hidden.length > 0 && (
        <MenuLabel right={<button type="button" className="db-link-btn" data-testid="db-show-all" onClick={() => {
          m.doc.transact(() => {
            for (const p of hidden) setViewProp(m.doc, view.id, p.id, { visible: true });
          });
        }}>Show all</button>}>Hidden in {view.type}</MenuLabel>
      )}
      {hidden.map(row)}
      {!m.locked && (
        <>
          <MenuSeparator />
          <MenuItem icon="plus" label="New property" testId="db-settings-new-property" onSelect={onAdd} />
        </>
      )}
    </div>
  );
}

function GroupPage({ m, view, sub, head }: { m: DatabaseModel; view: View; sub: boolean; head: React.ReactNode }) {
  const current = sub ? view.subGroupBy : view.groupBy;
  const prop = current ? m.schema.find((p) => p.id === current.prop) : undefined;
  const set = (g: GroupBy | null) => updateView(m.doc, view.id, sub ? { subGroupBy: g } : { groupBy: g });
  const base: GroupBy = { prop: "", date: "relative", text: "exact", status: "option", step: 10, sort: "manual", hideEmpty: false };
  const groups = current && prop ? groupRows(m.ctx, m.rows, { ...current, hideEmpty: false }, sub ? view.subGroups : view.groups) : [];
  return (
    <div className="db-menu">
      {head}
      <Row label="Group by">
        <PropSelect m={m} value={current?.prop ?? ""} testId={sub ? "db-subgroup-prop" : "db-group-prop"} onChange={(v) => set(v ? { ...(current ?? base), prop: v } : null)} filter={(p) => GROUPABLE.includes(p.type) && (!sub || p.id !== view.groupBy?.prop)} />
      </Row>
      {current && prop && (
        <>
          {(prop.type === "date" || prop.type === "created_time" || prop.type === "edited_time") && (
            <Row label="Date by">
              <select className="db-input" value={current.date} onChange={(e) => set({ ...current, date: e.target.value as GroupBy["date"] })}>
                <option value="relative">Relative</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </Row>
          )}
          {(prop.type === "text" || prop.type === "title" || prop.type === "url" || prop.type === "email" || prop.type === "phone") && (
            <Row label="Text by">
              <select className="db-input" value={current.text} onChange={(e) => set({ ...current, text: e.target.value as GroupBy["text"] })}>
                <option value="exact">Exact</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </Row>
          )}
          {prop.type === "status" && (
            <Row label="Show as">
              <select className="db-input" value={current.status} data-testid="db-status-show-as" onChange={(e) => set({ ...current, status: e.target.value as GroupBy["status"] })}>
                <option value="option">Option</option>
                <option value="group">Group</option>
              </select>
            </Row>
          )}
          {(prop.type === "number" || prop.type === "id") && (
            <Row label="Interval">
              <input className="db-input" type="number" defaultValue={current.step} onBlur={(e) => Number(e.target.value) > 0 && set({ ...current, step: Number(e.target.value) })} />
            </Row>
          )}
          <Row label="Sort">
            <select className="db-input" value={current.sort} onChange={(e) => set({ ...current, sort: e.target.value as GroupBy["sort"] })}>
              <option value="manual">Manual</option>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </Row>
          <Row label="Hide empty groups">
            <Toggle on={current.hideEmpty} testId="db-hide-empty" onChange={(on) => set({ ...current, hideEmpty: on })} />
          </Row>
          <MenuSeparator />
          <MenuLabel>Groups</MenuLabel>
          <div className="db-group-list">
            {groups.map((g) => (
              <div key={g.key} className="db-item" data-testid="db-group-vis">
                <span className="db-item-label">
                  <GroupLabel m={m} group={g} />
                  <span className="db-count">{g.rows.length}</span>
                </span>
                <button type="button" className="db-icon-btn" aria-label={g.hidden ? "Show group" : "Hide group"} onClick={() => setGroupState(m.doc, view.id, g.key, { hidden: !g.hidden }, sub)}>
                  <Icon name={g.hidden ? "eyeOff" : "eye"} size={16} />
                </button>
              </div>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem icon="trash" label="Remove grouping" danger testId="db-remove-group" onSelect={() => set(null)} />
        </>
      )}
    </div>
  );
}

registerCss(
  "settings",
  `
.db-set-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; padding: 0 8px; font-size: var(--n-t-body, 13px); }
.db-set-row > span { color: var(--n-text); white-space: nowrap; }
.db-set-ctl { display: flex; justify-content: flex-end; min-width: 0; }
.db-set-ctl .db-input { width: 140px; }
.db-layout-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 4px 8px 8px; }
.db-layout-tile { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 2px 6px; border-radius: var(--n-r-tile, 8px); border: none; box-shadow: inset 0 0 0 1px var(--n-control-border); background: var(--n-control); font-size: var(--n-t-small, 12px); color: var(--n-text-2); cursor: default; }
.db-layout-tile:hover { background: var(--n-control-hover); }
.db-layout-tile.is-on { box-shadow: inset 0 0 0 2px var(--n-form-accent); background: color-mix(in srgb, var(--n-form-accent) 15%, transparent); color: var(--n-text); }
.db-propvis.is-over-before { box-shadow: inset 0 2px 0 var(--n-form-accent); }
.db-propvis.is-over-after { box-shadow: inset 0 -2px 0 var(--n-form-accent); }
.db-group-list { max-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
`,
);
