import { useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import {
  COLORS,
  FORMULA_FUNCTIONS,
  NUMBER_FORMATS,
  DATE_FORMATS,
  PROP_TYPES,
  ROLLUP_LABELS,
  STATUS_GROUPS,
  TITLE,
  addOption,
  addProperty,
  compileFormula,
  evaluateFormula,
  fToText,
  isError,
  moveOption,
  readSchema,
  schemaOf,
  setViewProp,
  typeLabel,
  updateProperty,
  updateView,
  viewProperties,
  moveViewProp,
  readViews,
  syncBackRelation,
  type Property,
  type PropType,
  type RollupFn,
  type SelectOption,
  type StatusGroup,
  type View,
} from "../../shared/database";
import { newId } from "../../shared/model";
import type { DatabaseModel } from "./data";
import { databasesIn } from "./data";
import type { Actions } from "./actions";
import { OptionMenu } from "./cells";
import { Icon, TypeIcon } from "./icons";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, StatusDot, Tag, Toggle, usePopover, type Anchor } from "./ui";
import { registerCss } from "./styles";

export function PropertyMenu({ m, actions, prop, view, anchor, onClose, onFilter }: { m: DatabaseModel; actions: Actions; prop: Property; view: View | null; anchor: Anchor; onClose: () => void; onFilter?: (prop: string) => void }) {
  const [name, setName] = useState(prop.name);
  const [page, setPage] = useState<"main" | "edit">("main");
  const typeMenu = usePopover();
  const locked = m.locked;
  const commitName = () => {
    if (name.trim() !== prop.name && !locked) actions.updatePropertyName(prop.id, name.trim() || prop.name);
  };
  const close = () => {
    commitName();
    onClose();
  };
  const cols = view ? viewProperties(view, m.schema) : [];
  const index = cols.findIndex((c) => c.id === prop.id);
  if (page === "edit")
    return (
      <Popover anchor={anchor} onClose={close} width={290} testId="db-prop-edit">
        <div className="db-menu">
          <div className="db-panel-head">
            <button type="button" className="db-icon-btn" aria-label="Back" onClick={() => setPage("main")}>
              <Icon name="arrowLeft" size={14} />
            </button>
            <span>Edit property</span>
          </div>
          <PropertyConfig m={m} actions={actions} prop={m.schema.find((p) => p.id === prop.id) ?? prop} />
        </div>
      </Popover>
    );
  return (
    <Popover anchor={anchor} onClose={close} width={260} testId="db-prop-menu">
      <Menu autoFocus={false}>
        <div className="db-menu-pad db-prop-name-row">
          <span className="db-prop-type-icon">
            <TypeIcon type={prop.type} size={16} />
          </span>
          <input
            className="db-input"
            value={name}
            disabled={locked}
            autoFocus={!locked}
            data-testid="db-prop-name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                close();
              }
            }}
          />
        </div>
        {!locked && prop.id !== TITLE && <MenuItem icon="settings" label="Edit property" testId="db-prop-edit-open" onSelect={() => setPage("edit")} />}
        {!locked && prop.id !== TITLE && <MenuItem icon={<TypeIcon type={prop.type} size={16} />} label="Change type" right={typeLabel(prop.type)} chevron testId="db-prop-type" onSelect={(el) => typeMenu.open(el)} />}
        {!locked && hasConfig(prop.type) && prop.id === TITLE && <MenuItem icon="settings" label="Edit property" onSelect={() => setPage("edit")} />}
        <MenuSeparator />
        {view && (
          <>
            <MenuItem icon="filter" label="Filter" testId="db-prop-filter" onSelect={() => {
              onFilter?.(prop.id);
              onClose();
            }} />
            <MenuItem icon="arrowUp" label="Sort ascending" testId="db-prop-sort-asc" onSelect={() => {
              updateView(m.doc, view.id, { sorts: [{ id: newId(), prop: prop.id, dir: "asc" }] });
              onClose();
            }} />
            <MenuItem icon="arrowDown" label="Sort descending" testId="db-prop-sort-desc" onSelect={() => {
              updateView(m.doc, view.id, { sorts: [{ id: newId(), prop: prop.id, dir: "desc" }] });
              onClose();
            }} />
            {!locked && view.type === "table" && (
              <MenuItem icon="group" label="Group" onSelect={() => {
                updateView(m.doc, view.id, { groupBy: { prop: prop.id, date: "relative", text: "exact", status: "option", step: 10, sort: "manual", hideEmpty: false } });
                onClose();
              }} />
            )}
            <MenuSeparator />
            {!locked && view.type === "table" && (
              <MenuItem icon="freeze" label={view.frozen === index + 1 ? "Unfreeze columns" : "Freeze up to column"} onSelect={() => {
                updateView(m.doc, view.id, { frozen: view.frozen === index + 1 ? 0 : index + 1 });
                onClose();
              }} />
            )}
            {!locked && prop.id !== TITLE && (
              <MenuItem icon="eyeOff" label="Hide in view" testId="db-prop-hide" onSelect={() => {
                setViewProp(m.doc, view.id, prop.id, { visible: false });
                onClose();
              }} />
            )}
            {!locked && view.type === "table" && (
              <MenuItem icon="wrap" label="Wrap column" right={<Toggle on={view.wrap} onChange={(on) => updateView(m.doc, view.id, { wrap: on })} />} onSelect={() => updateView(m.doc, view.id, { wrap: !view.wrap })} />
            )}
          </>
        )}
        {!locked && view && view.type === "table" && (
          <>
            <MenuSeparator />
            {prop.id !== TITLE && <MenuItem icon="arrowLeft" label="Insert left" onSelect={() => {
              insertBeside(m, actions, view, cols, index, "left");
              onClose();
            }} />}
            <MenuItem icon="arrowRight" label="Insert right" testId="db-prop-insert-right" onSelect={() => {
              insertBeside(m, actions, view, cols, index, "right");
              onClose();
            }} />
          </>
        )}
        {!locked && prop.id !== TITLE && (
          <>
            <MenuItem icon="copy" label="Duplicate property" onSelect={() => {
              const id = actions.duplicateProperty(prop.id);
              if (id && view) setViewProp(m.doc, view.id, id, { visible: true });
              onClose();
            }} />
            <MenuItem icon="trash" label="Delete property" danger testId="db-prop-delete" onSelect={() => {
              actions.removeProperty(prop.id);
              onClose();
            }} />
          </>
        )}
      </Menu>
      {typeMenu.state && (
        <Popover anchor={typeMenu.state.anchor} onClose={typeMenu.close} placement="right-start" width={220} testId="db-type-menu">
          <Menu>
            {PROP_TYPES.map((t) => (
              <MenuItem key={t.type} testId="db-type-option" icon={<TypeIcon type={t.type} size={16} />} label={t.label} checked={t.type === prop.type} onSelect={() => {
                actions.changeType(prop.id, t.type);
                typeMenu.close();
                if (hasConfig(t.type)) setPage("edit");
              }} />
            ))}
          </Menu>
        </Popover>
      )}
    </Popover>
  );
}

function insertBeside(m: DatabaseModel, actions: Actions, view: View, cols: Property[], index: number, side: "left" | "right") {
  const id = actions.newProperty("text", { view });
  const after = side === "right" ? cols[index]?.id ?? null : cols[index - 1]?.id ?? null;
  const fresh = readViews(m.doc).find((v) => v.id === view.id);
  if (fresh) moveViewProp(m.doc, fresh, readSchema(m.schemaDoc), id, after);
}

export const hasConfig = (type: PropType) => ["select", "multi_select", "status", "number", "date", "formula", "relation", "rollup", "id", "created_time", "edited_time"].includes(type);

export function PropertyConfig({ m, actions, prop }: { m: DatabaseModel; actions: Actions; prop: Property }) {
  switch (prop.type) {
    case "select":
    case "multi_select":
    case "status":
      return <OptionsConfig m={m} prop={prop} />;
    case "number":
      return <NumberConfig m={m} prop={prop} />;
    case "date":
    case "created_time":
    case "edited_time":
      return <DateConfig m={m} prop={prop} />;
    case "formula":
      return <FormulaConfig m={m} prop={prop} />;
    case "relation":
      return <RelationConfig m={m} prop={prop} />;
    case "rollup":
      return <RollupConfig m={m} prop={prop} />;
    case "id":
      return (
        <div className="db-menu-pad db-config">
          <label className="db-config-label">Prefix</label>
          <input className="db-input" defaultValue={prop.prefix} placeholder="e.g. TASK" data-testid="db-id-prefix" onBlur={(e) => updateProperty(m.schemaDoc, prop.id, { prefix: e.target.value.trim().slice(0, 20) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      );
    default:
      void actions;
      return <div className="db-empty-note">No settings for this property type.</div>;
  }
}

function OptionsConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  const [adding, setAdding] = useState<StatusGroup | "plain" | null>(null);
  const [text, setText] = useState("");
  const menu = usePopover<SelectOption>();
  const drag = useRef<string | null>(null);
  const groups: (StatusGroup | null)[] = prop.type === "status" ? STATUS_GROUPS.map((g) => g.id) : [null];
  const add = (group: StatusGroup | null) => {
    if (!text.trim()) {
      setAdding(null);
      return;
    }
    addOption(m.schemaDoc, prop.id, text.trim(), group ? { group } : {});
    setText("");
  };
  return (
    <div className="db-options-config" data-testid="db-options-config">
      {groups.map((g) => {
        const list = prop.options.filter((o) => (g ? (o.group ?? "todo") === g : true));
        return (
          <div key={g ?? "all"} onDragOver={(e) => drag.current && e.preventDefault()} onDrop={(e) => {
            if (!drag.current || !g) return;
            e.preventDefault();
            if (!list.length) moveOption(m.schemaDoc, prop.id, drag.current, null, g);
            drag.current = null;
          }}>
            <MenuLabel right={<button type="button" className="db-icon-btn" aria-label="Add option" data-testid="db-add-option" onClick={() => {
              setAdding(g ?? "plain");
              setText("");
            }}><Icon name="plus" size={14} /></button>}>
              {g ? STATUS_GROUPS.find((x) => x.id === g)!.name : "Options"}
            </MenuLabel>
            {adding === (g ?? "plain") && (
              <div className="db-menu-pad">
                <input className="db-input" autoFocus value={text} data-testid="db-new-option" placeholder="Type a name…" onChange={(e) => setText(e.target.value)} onBlur={() => add(g)} onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add(g);
                  }
                  if (e.key === "Escape") setAdding(null);
                }} />
              </div>
            )}
            {list.map((o) => (
              <div
                key={o.id}
                className="db-item db-option-row"
                data-menu-item=""
                data-testid="db-config-option"
                draggable
                onDragStart={() => (drag.current = o.id)}
                onDragOver={(e) => drag.current && drag.current !== o.id && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const from = drag.current;
                  drag.current = null;
                  if (!from || from === o.id) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < r.top + r.height / 2;
                  const others = list.filter((x) => x.id !== from);
                  const i = others.findIndex((x) => x.id === o.id);
                  const after = before ? others[i - 1]?.id ?? null : o.id;
                  moveOption(m.schemaDoc, prop.id, from, after, g ?? undefined);
                }}
                onMouseEnter={(e) => e.currentTarget.classList.add("is-active")}
                onMouseLeave={(e) => e.currentTarget.classList.remove("is-active")}
                onClick={(e) => menu.open(e.currentTarget, o)}
              >
                <span className="db-drag-handle"><Icon name="drag" size={12} /></span>
                <span className="db-item-label">
                  {prop.type === "status" ? (
                    <Tag color={o.color} className="db-status-tag"><StatusDot color={o.color} />{o.name}</Tag>
                  ) : (
                    <Tag color={o.color}>{o.name}</Tag>
                  )}
                </span>
                <Icon name="chevronRight" size={14} className="db-item-chevron" />
              </div>
            ))}
          </div>
        );
      })}
      {menu.state && <OptionMenu m={m} prop={prop} option={prop.options.find((o) => o.id === menu.state!.value.id) ?? menu.state.value} anchor={menu.state.anchor} onClose={menu.close} />}
    </div>
  );
}

function NumberConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  return (
    <div className="db-menu-pad db-config">
      <label className="db-config-label">Number format</label>
      <select className="db-input" value={prop.format} data-testid="db-number-format" onChange={(e) => updateProperty(m.schemaDoc, prop.id, { format: e.target.value as Property["format"] })}>
        {NUMBER_FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <label className="db-config-label">Show as</label>
      <div className="db-show-as">
        {(["number", "bar", "ring"] as const).map((d) => (
          <button type="button" key={d} data-testid={`db-show-${d}`} className={`db-show-tile ${prop.display === d ? "is-on" : ""}`} onClick={() => updateProperty(m.schemaDoc, prop.id, { display: d })}>
            <span className="db-show-preview">{d === "number" ? "42" : d === "bar" ? <span className="db-bar" style={{ width: 36 }}><span className="db-bar-fill b-green" style={{ width: "60%" }} /></span> : <svg width="18" height="18" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" strokeWidth="2.5" className="db-ring-track" /><circle cx="10" cy="10" r="7" fill="none" strokeWidth="2.5" className="db-ring-fill b-green" strokeDasharray="26 44" transform="rotate(-90 10 10)" /></svg>}</span>
            {d[0]!.toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      {prop.display !== "number" && (
        <>
          <label className="db-config-label">Color</label>
          <div className="db-color-row">
            {COLORS.filter((c) => c !== "default").map((c) => (
              <button type="button" key={c} aria-label={c} className={`db-color-dot b-${c} ${prop.barColor === c ? "is-on" : ""}`} onClick={() => updateProperty(m.schemaDoc, prop.id, { barColor: c })} />
            ))}
          </div>
          <label className="db-config-label">Divide by</label>
          <input className="db-input" type="number" defaultValue={prop.divideBy} onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0) updateProperty(m.schemaDoc, prop.id, { divideBy: n });
          }} />
          <div className="db-config-toggle">
            <span>Show number</span>
            <Toggle on={prop.showNumber} onChange={(on) => updateProperty(m.schemaDoc, prop.id, { showNumber: on })} />
          </div>
        </>
      )}
    </div>
  );
}

function DateConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  return (
    <div className="db-menu-pad db-config">
      <label className="db-config-label">Date format</label>
      <select className="db-input" value={prop.dateFormat} data-testid="db-date-format" onChange={(e) => updateProperty(m.schemaDoc, prop.id, { dateFormat: e.target.value as Property["dateFormat"] })}>
        {DATE_FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <label className="db-config-label">Time format</label>
      <select className="db-input" value={prop.timeFormat} onChange={(e) => updateProperty(m.schemaDoc, prop.id, { timeFormat: e.target.value as Property["timeFormat"] })}>
        <option value="12">12 hour</option>
        <option value="24">24 hour</option>
        <option value="hidden">Hidden</option>
      </select>
    </div>
  );
}

const FORMULA_HELP: Record<string, string> = {
  prop: 'prop("Name") reads a property',
  if: "if(condition, then, else)",
  ifs: "ifs(cond1, value1, cond2, value2, …, else)",
  concat: "concat(a, b, …) joins text or lists",
  format: "format(value) turns a value into text",
  length: "length(text or list)",
  contains: "contains(text, part)",
  replace: "replace(text, find, with) first match",
  replaceAll: "replaceAll(text, find, with)",
  dateAdd: 'dateAdd(date, 3, "days")',
  dateBetween: 'dateBetween(end, start, "days")',
  now: "now() current date and time",
  today: "today() current date",
  formatDate: 'formatDate(date, "MMM D, YYYY")',
  round: "round(number, places)",
  min: "min(a, b, …)",
  max: "max(a, b, …)",
  and: "and(a, b) or a and b",
  or: "or(a, b) or a or b",
  not: "not(a) or not a",
  map: "map(list, current * 2)",
  filter: "filter(list, current > 1)",
  let: "let(name, value, expression)",
};

function FormulaConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  const [text, setText] = useState(prop.expression);
  const sample = m.rows[0];
  const compiled = compileFormula(text);
  const preview = useMemo(() => {
    if (!text.trim()) return "";
    if (isError(compiled) && !("k" in compiled)) return `Error: ${compiled.error}`;
    if (!sample) return "No rows to preview";
    const v = evaluateFormula({ ...m.ctx, cache: new Map(), stack: new Set() }, sample, text);
    return isError(v) ? `Error: ${v.error}` : fToText(v) || "Empty";
  }, [text, sample, m.ctx]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const insert = (s: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const next = text.slice(0, start) + s + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + s.length, start + s.length);
    });
  };
  const [q, setQ] = useState("");
  const props = m.schema.filter((p) => p.id !== prop.id && p.name.toLowerCase().includes(q.toLowerCase()));
  const fns = FORMULA_FUNCTIONS.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <div className="db-formula" data-testid="db-formula">
      <textarea
        ref={ref}
        className="db-formula-input"
        value={text}
        spellCheck={false}
        autoFocus
        data-testid="db-formula-input"
        placeholder='Type a formula, e.g. prop("Price") * 2'
        onChange={(e) => {
          setText(e.target.value.slice(0, 4000));
          const word = /[A-Za-z_]*$/.exec(e.target.value.slice(0, e.target.selectionStart))?.[0] ?? "";
          setQ(word);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            updateProperty(m.schemaDoc, prop.id, { expression: text });
          }
        }}
      />
      <div className={`db-formula-preview ${preview.startsWith("Error") ? "is-error" : ""}`} data-testid="db-formula-preview">
        {preview}
      </div>
      <div className="db-formula-actions">
        <button type="button" className="db-btn is-primary" data-testid="db-formula-save" onClick={() => updateProperty(m.schemaDoc, prop.id, { expression: text })}>
          Done
        </button>
      </div>
      <div className="db-formula-ref">
        <MenuLabel>Properties</MenuLabel>
        {props.map((p) => (
          <MenuItem key={p.id} icon={<TypeIcon type={p.type} size={14} />} label={p.name} onSelect={() => insert(`prop("${p.name.replace(/"/g, '\\"')}")`)} />
        ))}
        <MenuLabel>Functions</MenuLabel>
        {fns.map((f) => (
          <MenuItem key={f} label={<span className="db-mono">{f}</span>} right={FORMULA_HELP[f] ? <span className="db-formula-help">{FORMULA_HELP[f]}</span> : undefined} onSelect={() => insert(`${f}(`)} />
        ))}
      </div>
    </div>
  );
}

function RelationConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  const dbs = databasesIn(m.store);
  const target = m.store.pages.get(prop.relation);
  const pick = (id: string) => {
    m.schemaDoc.transact(() => {
      const entry = schemaOf(m.schemaDoc).get(prop.id);
      entry?.set("relation", id);
      entry?.set("twoWay", false);
      entry?.set("backProp", "");
    });
  };
  const setTwoWay = (on: boolean) => {
    const targetDoc = prop.relation === m.source ? m.schemaDoc : m.docFor(prop.relation);
    if (on) {
      if (!targetDoc) return;
      const back = newId();
      const self = prop.relation === m.source;
      addProperty(targetDoc, { type: "relation", name: self ? `Related to ${prop.name}` : `Related to ${m.sourceMeta?.title || "Untitled"}`, relation: m.source, twoWay: true, backProp: prop.id }, { id: back });
      updateProperty(m.schemaDoc, prop.id, { twoWay: true, backProp: back });
      const fresh = readSchema(m.schemaDoc).find((p) => p.id === prop.id);
      if (fresh) syncBackRelation(m.tree, m.source, fresh, m.me.deviceId);
    } else {
      if (targetDoc && prop.backProp) {
        const entry = (targetDoc.getMap("schema") as Y.Map<Y.Map<unknown>>).get(prop.backProp);
        entry?.set("deleted", true);
      }
      updateProperty(m.schemaDoc, prop.id, { twoWay: false, backProp: "" });
    }
  };
  return (
    <div className="db-menu-pad db-config">
      <label className="db-config-label">Related to</label>
      <select className="db-input" value={prop.relation} data-testid="db-relation-target" onChange={(e) => pick(e.target.value)}>
        {!target && <option value="">Choose a database…</option>}
        {dbs.map((d) => (
          <option key={d.id} value={d.id}>
            {(d.icon && !d.icon.startsWith("file:") ? `${d.icon} ` : "") + (d.title || "Untitled")}
            {d.id === m.source ? " (this database)" : ""}
          </option>
        ))}
      </select>
      <div className="db-config-toggle">
        <span>Show on {prop.relation === m.source ? "this database" : target?.title || "Untitled"}</span>
        <Toggle on={prop.twoWay} testId="db-two-way" onChange={setTwoWay} />
      </div>
      {prop.twoWay && <div className="db-config-note">Two-way: linking a page here also links it back.</div>}
    </div>
  );
}

function RollupConfig({ m, prop }: { m: DatabaseModel; prop: Property }) {
  const relations = m.schema.filter((p) => p.type === "relation");
  const relation = relations.find((r) => r.id === prop.rollupRelation);
  const targetDoc = relation ? m.docFor(relation.relation) : null;
  const targetSchema = targetDoc ? readSchema(targetDoc) : [];
  return (
    <div className="db-menu-pad db-config">
      <label className="db-config-label">Relation</label>
      <select className="db-input" value={prop.rollupRelation} data-testid="db-rollup-relation" onChange={(e) => updateProperty(m.schemaDoc, prop.id, { rollupRelation: e.target.value, rollupTarget: TITLE })}>
        <option value="">Select a relation…</option>
        {relations.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <label className="db-config-label">Property</label>
      <select className="db-input" value={prop.rollupTarget} data-testid="db-rollup-target" disabled={!relation} onChange={(e) => updateProperty(m.schemaDoc, prop.id, { rollupTarget: e.target.value })}>
        {targetSchema.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="db-config-label">Calculate</label>
      <select className="db-input" value={prop.rollupFn} data-testid="db-rollup-fn" onChange={(e) => updateProperty(m.schemaDoc, prop.id, { rollupFn: e.target.value as RollupFn })}>
        {(Object.keys(ROLLUP_LABELS) as RollupFn[]).filter((f) => (f as string) !== "none").map((f) => (
          <option key={f} value={f}>
            {ROLLUP_LABELS[f]}
          </option>
        ))}
      </select>
      <label className="db-config-label">Number format</label>
      <select className="db-input" value={prop.format} onChange={(e) => updateProperty(m.schemaDoc, prop.id, { format: e.target.value as Property["format"] })}>
        {NUMBER_FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

registerCss(
  "property-menu",
  `
.db-panel-head { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px; font-weight: 500; font-size: var(--n-t-body, 13px); }
.db-prop-name-row { display: flex; gap: 6px; align-items: center; }
.db-prop-type-icon { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--n-r-tile, 8px); background: var(--n-control); box-shadow: inset 0 0 0 1px var(--n-control-border); color: var(--n-icon); flex: none; }
.db-config { display: flex; flex-direction: column; gap: 6px; }
.db-config-label { font-size: 12px; color: var(--n-text-2); margin-top: 4px; }
.db-config-toggle { display: flex; align-items: center; justify-content: space-between; min-height: 28px; font-size: var(--n-t-body, 13px); }
.db-config-note { font-size: 12px; color: var(--n-text-3); }
.db-show-as { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.db-show-tile { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px 6px; border-radius: var(--n-r-tile, 8px); border: none; box-shadow: inset 0 0 0 1px var(--n-control-border); background: var(--n-control); font-size: var(--n-t-small, 12px); color: var(--n-text-2); cursor: default; }
.db-show-tile.is-on { box-shadow: inset 0 0 0 2px var(--n-form-accent); background: color-mix(in srgb, var(--n-form-accent) 15%, transparent); color: var(--n-text); }
.db-show-preview { height: 20px; display: flex; align-items: center; font-size: 15px; color: var(--n-text); }
.db-color-row { display: flex; gap: 6px; flex-wrap: wrap; }
.db-color-dot { width: 18px; height: 18px; border-radius: 50%; border: none; cursor: default; }
.db-color-dot.is-on { box-shadow: 0 0 0 2px var(--n-surface), 0 0 0 3.5px var(--n-form-accent); }
.db-options-config { max-height: 380px; overflow: auto; }
.db-formula { display: flex; flex-direction: column; width: 100%; }
.db-formula-input { margin: 4px; min-height: 84px; padding: 8px; border-radius: var(--n-r-tile, 8px); border: none; box-shadow: inset 0 0 0 1px var(--n-field-border); background: var(--n-field); color: var(--n-text); font-family: var(--n-font-mono, ui-monospace, monospace); font-size: var(--n-t-body, 13px); line-height: 1.5; resize: vertical; outline: none; }
.db-formula-input:focus { border-color: var(--n-form-accent); }
.db-formula-preview { padding: 4px 10px; font-size: 13px; color: var(--n-text-2); min-height: 22px; white-space: pre-wrap; word-break: break-word; }
.db-formula-preview.is-error { color: var(--n-destructive); }
.db-formula-actions { display: flex; justify-content: flex-end; padding: 0 6px 6px; }
.db-formula-ref { border-top: 0.5px solid var(--n-divider); max-height: 240px; overflow: auto; padding: 4px; }
.db-mono { font-family: var(--n-font-mono, ui-monospace, monospace); font-size: 13px; }
.db-formula-help { font-size: 11px; color: var(--n-text-3); max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
`,
);
