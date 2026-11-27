import { useEffect, useRef, useState } from "react";
import {
  RELATIVE_RANGES,
  condsFor,
  defaultCond,
  isValueless,
  kindOf,
  ruleIsActive,
  updateView,
  type FilterCond,
  type FilterGroup,
  type FilterRule,
  type Kind,
  type Property,
  type SortRule,
  type View,
  STATUS_GROUPS,
} from "../../shared/database";
import { newId } from "../../shared/model";
import type { DatabaseModel } from "./data";
import { Icon, TypeIcon } from "./icons";
import { Avatar, Menu, MenuItem, MenuLabel, MenuSeparator, Popover, StatusDot, Tag, usePopover, type Anchor } from "./ui";
import { registerCss } from "./styles";
import { exitRef, useFlip } from "../ui/motion";

const chipExit = exitRef<HTMLButtonElement>("is-leaving", 90);

export function newRule(m: DatabaseModel, prop: string): FilterRule {
  const p = m.schema.find((x) => x.id === prop);
  return { kind: "rule", id: newId(), prop, cond: p ? defaultCond(kindOf(m.ctx, p)) : "contains" };
}

export function PropPicker({ m, anchor, onClose, onPick, filter, title = "Filter by" }: { m: DatabaseModel; anchor: Anchor; onClose: () => void; onPick: (prop: Property) => void; filter?: (p: Property) => boolean; title?: string }) {
  const [q, setQ] = useState("");
  const list = m.schema.filter((p) => (filter ? filter(p) : true) && p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} width={240} testId="db-prop-picker">
      <Menu autoFocus={false}>
        <div className="db-menu-pad">
          <input className="db-input" autoFocus placeholder={`${title}…`} value={q} data-testid="db-prop-picker-search" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter" && list[0]) onPick(list[0]);
          }} />
        </div>
        {list.map((p) => (
          <MenuItem key={p.id} testId="db-prop-pick" icon={<TypeIcon type={p.type} size={16} />} label={p.name || "Untitled"} onSelect={() => onPick(p)} />
        ))}
        {!list.length && <div className="db-empty-note">No properties</div>}
      </Menu>
    </Popover>
  );
}

function summary(m: DatabaseModel, rule: FilterRule, prop: Property | undefined): string {
  if (!prop) return "";
  if (isValueless(rule.cond)) return condsFor(kindOf(m.ctx, prop)).find((c) => c.id === rule.cond)?.label ?? "";
  const v = rule.value;
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) {
    const names = v.map((id) => {
      const s = String(id);
      return prop.options.find((o) => o.id === s)?.name ?? m.people.get(s)?.name ?? m.store.pages.get(s)?.title ?? s;
    });
    return `${rule.cond === "is_not" || rule.cond === "not_contains" ? "not " : ""}${names.join(", ")}`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.relative === "string") return RELATIVE_RANGES.find((r) => r.id === o.relative)?.label ?? "";
    if (o.start || o.end) return `${o.start ?? "…"} → ${o.end ?? "…"}`;
    return String(o.date ?? "");
  }
  const cond = condsFor(kindOf(m.ctx, prop)).find((c) => c.id === rule.cond);
  return `${cond && !["is", "contains"].includes(rule.cond) ? `${cond.label.toLowerCase()} ` : ""}${String(v)}`;
}

export function FilterBar({ m, view, editable, openSort, addFilterFor, clearAddFor }: { m: DatabaseModel; view: View; editable: boolean; openSort: (anchor: HTMLElement) => void; addFilterFor: string | null; clearAddFor: () => void }) {
  const ruleMenu = usePopover<string>();
  const adv = usePopover<string>();
  const picker = usePopover();
  const setFilter = (filter: FilterGroup) => updateView(m.doc, view.id, { filter });
  const rules = view.filter.rules;
  const barRef = useRef<HTMLDivElement | null>(null);
  useFlip(barRef, ".db-chip[data-flip]", "data-flip", [view.sorts.length, rules.map((r) => r.id).join(), editable]);
  useEffect(() => {
    if (!addFilterFor) return;
    const rule = newRule(m, addFilterFor);
    setFilter({ ...view.filter, rules: [...view.filter.rules, rule] });
    clearAddFor();
    requestAnimationFrame(() => {
      const el = barRef.current?.querySelector<HTMLElement>(`[data-rule="${rule.id}"]`);
      if (el) ruleMenu.open(el, rule.id);
    });
  }, [addFilterFor]);
  const sortLabel = view.sorts.length === 1 ? m.schema.find((p) => p.id === view.sorts[0]!.prop)?.name ?? "Sort" : `${view.sorts.length} sorts`;
  const activeRule = ruleMenu.state ? (rules.find((r) => r.id === ruleMenu.state!.value) as FilterRule | undefined) : undefined;
  const activeGroup = adv.state ? (rules.find((r) => r.id === adv.state!.value) as FilterGroup | undefined) : undefined;
  return (
    <div className="db-filterbar" ref={barRef} data-testid="db-filterbar">
      {view.sorts.length > 0 && (
        <button type="button" ref={chipExit} data-flip="sort" className="db-chip is-on" data-testid="db-sort-chip" onClick={(e) => openSort(e.currentTarget)}>
          <Icon name={view.sorts[0]!.dir === "desc" ? "arrowDown" : "arrowUp"} size={14} />
          {sortLabel}
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {view.sorts.length > 0 && rules.length > 0 && <span className="db-chip-sep" />}
      {rules.map((r) => {
        if (r.kind === "group")
          return (
            <button type="button" key={r.id} ref={chipExit} data-rule={r.id} data-flip={r.id} className="db-chip is-on" data-testid="db-filter-chip" onClick={(e) => adv.open(e.currentTarget, r.id)}>
              <Icon name="filter" size={14} />
              {countRules(r)} rule{countRules(r) === 1 ? "" : "s"}
              <Icon name="chevronDown" size={12} />
            </button>
          );
        const prop = m.schema.find((p) => p.id === r.prop);
        const s = summary(m, r, prop);
        return (
          <button type="button" key={r.id} ref={chipExit} data-rule={r.id} data-flip={r.id} className={`db-chip ${ruleIsActive(r) ? "is-on" : ""}`} data-testid="db-filter-chip" onClick={(e) => ruleMenu.open(e.currentTarget, r.id)}>
            {prop && <TypeIcon type={prop.type} size={14} />}
            <span className="db-chip-name">{prop?.name ?? "Deleted property"}</span>
            {s && <span className="db-chip-value">: {s}</span>}
            <Icon name="chevronDown" size={12} />
          </button>
        );
      })}
      <button type="button" data-flip="add" className="db-chip is-add" data-testid="db-add-filter" onClick={(e) => picker.open(e.currentTarget)}>
        <Icon name="plus" size={14} />
        Filter
      </button>
      {rules.length > 0 && editable && (
        <button type="button" data-flip="adv" className="db-chip is-add" data-testid="db-advanced-filter" onClick={(e) => {
          const existing = rules.find((r) => r.kind === "group") as FilterGroup | undefined;
          if (existing) adv.open(e.currentTarget, existing.id);
          else {
            const group: FilterGroup = { kind: "group", id: newId(), op: "and", rules: rules.filter((r): r is FilterRule => r.kind === "rule") };
            setFilter({ ...view.filter, rules: [group] });
            const el = e.currentTarget;
            requestAnimationFrame(() => adv.open(barRef.current?.querySelector<HTMLElement>(`[data-rule="${group.id}"]`) ?? el, group.id));
          }
        }}>
          Advanced
        </button>
      )}
      {picker.state && (
        <PropPicker m={m} anchor={picker.state.anchor} onClose={picker.close} onPick={(p) => {
          picker.close();
          const rule = newRule(m, p.id);
          setFilter({ ...view.filter, rules: [...rules, rule] });
          requestAnimationFrame(() => {
            const el = barRef.current?.querySelector<HTMLElement>(`[data-rule="${rule.id}"]`);
            if (el) ruleMenu.open(el, rule.id);
          });
        }} />
      )}
      {ruleMenu.state && activeRule && (
        <Popover anchor={ruleMenu.state.anchor} onClose={ruleMenu.close} width={300} testId="db-rule-editor">
          <RuleEditor m={m} rule={activeRule} onChange={(next) => setFilter({ ...view.filter, rules: rules.map((r) => (r.id === next.id ? next : r)) })} onDelete={() => {
            ruleMenu.close();
            setFilter({ ...view.filter, rules: rules.filter((r) => r.id !== activeRule.id) });
          }} />
        </Popover>
      )}
      {adv.state && activeGroup && (
        <Popover anchor={adv.state.anchor} onClose={adv.close} width={640} testId="db-advanced-editor">
          <AdvancedFilter m={m} group={activeGroup} depth={0} onChange={(next) => setFilter({ ...view.filter, rules: rules.map((r) => (r.id === next.id ? next : r)) })} onDelete={() => {
            adv.close();
            setFilter({ ...view.filter, rules: rules.filter((r) => r.id !== activeGroup.id) });
          }} />
        </Popover>
      )}
    </div>
  );
}

const countRules = (g: FilterGroup): number => g.rules.reduce((n, r) => n + (r.kind === "group" ? countRules(r) : 1), 0);

export function RuleEditor({ m, rule, onChange, onDelete }: { m: DatabaseModel; rule: FilterRule; onChange: (r: FilterRule) => void; onDelete: () => void }) {
  const prop = m.schema.find((p) => p.id === rule.prop);
  const condMenu = usePopover();
  const more = usePopover();
  if (!prop) return <div className="db-empty-note">This property was deleted.</div>;
  const kind = kindOf(m.ctx, prop);
  const conds = condsFor(kind);
  return (
    <div className="db-rule">
      <div className="db-rule-head">
        <span className="db-rule-prop">{prop.name}</span>
        <button type="button" className="db-link-btn" data-testid="db-rule-cond" onClick={(e) => condMenu.open(e.currentTarget)}>
          {conds.find((c) => c.id === rule.cond)?.label ?? "Is"} <Icon name="chevronDown" size={10} />
        </button>
        <span className="db-flex" />
        <button type="button" className="db-icon-btn" aria-label="More" data-testid="db-rule-more" onClick={(e) => more.open(e.currentTarget)}>
          <Icon name="more" size={14} />
        </button>
      </div>
      {!isValueless(rule.cond) && <ValueInput m={m} prop={prop} kind={kind} rule={rule} onChange={onChange} />}
      {condMenu.state && (
        <Popover anchor={condMenu.state.anchor} onClose={condMenu.close} width={200} testId="db-cond-menu">
          <Menu>
            {conds.map((c) => (
              <MenuItem key={c.id} label={c.label} testId="db-cond-option" checked={c.id === rule.cond} onSelect={() => {
                condMenu.close();
                const keep = sameValueShape(rule.cond, c.id);
                onChange({ ...rule, cond: c.id, ...(keep ? {} : { value: undefined }) } as FilterRule);
              }} />
            ))}
          </Menu>
        </Popover>
      )}
      {more.state && (
        <Popover anchor={more.state.anchor} onClose={more.close} width={180}>
          <Menu>
            <MenuItem icon="trash" label="Delete filter" danger testId="db-rule-delete" onSelect={onDelete} />
          </Menu>
        </Popover>
      )}
    </div>
  );
}

function sameValueShape(a: FilterCond, b: FilterCond) {
  const shape = (c: FilterCond) => (c === "between" ? "range" : c === "relative" ? "relative" : isValueless(c) ? "none" : "single");
  return shape(a) === shape(b);
}

function ValueInput({ m, prop, kind, rule, onChange }: { m: DatabaseModel; prop: Property; kind: Kind; rule: FilterRule; onChange: (r: FilterRule) => void }) {
  const set = (value: unknown) => onChange({ ...rule, value } as FilterRule);
  const computed = prop.type === "formula" || prop.type === "rollup";
  if ((kind === "select" || kind === "multi") && !computed) {
    const chosen = Array.isArray(rule.value) ? (rule.value as string[]) : [];
    const toggle = (id: string) => set(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
    return (
      <div className="db-rule-options">
        {prop.type === "status" &&
          STATUS_GROUPS.map((g) => (
            <div key={g.id}>
              <MenuLabel>{g.name}</MenuLabel>
              {prop.options.filter((o) => (o.group ?? "todo") === g.id).map((o) => (
                <MenuItem key={o.id} testId="db-rule-option" icon={<span className={`db-check ${chosen.includes(o.id) ? "is-on" : ""}`}>{chosen.includes(o.id) && <Icon name="check" size={12} strokeWidth={2} />}</span>} label={<Tag color={o.color} className="db-status-tag"><StatusDot color={o.color} />{o.name}</Tag>} onSelect={() => toggle(o.id)} />
              ))}
            </div>
          ))}
        {prop.type !== "status" &&
          prop.options.map((o) => (
            <MenuItem key={o.id} testId="db-rule-option" icon={<span className={`db-check ${chosen.includes(o.id) ? "is-on" : ""}`}>{chosen.includes(o.id) && <Icon name="check" size={12} strokeWidth={2} />}</span>} label={<Tag color={o.color}>{o.name}</Tag>} onSelect={() => toggle(o.id)} />
          ))}
        {!prop.options.length && <div className="db-empty-note">No options</div>}
      </div>
    );
  }
  if (kind === "person" && !computed) {
    const chosen = Array.isArray(rule.value) ? (rule.value as string[]) : [];
    return (
      <div className="db-rule-options">
        {[...m.people.values()].map((p) => (
          <MenuItem key={p.id} icon={<Avatar name={p.name} color={p.color} size={18} />} label={p.name} checked={chosen.includes(p.id)} onSelect={() => set(chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])} />
        ))}
      </div>
    );
  }
  if (kind === "relation" && !computed) {
    const chosen = Array.isArray(rule.value) ? (rule.value as string[]) : [];
    const pages = m.store.children(prop.relation).slice(0, 200);
    return (
      <div className="db-rule-options">
        {pages.map((p) => (
          <MenuItem key={p.id} icon="page" label={p.title || "Untitled"} checked={chosen.includes(p.id)} onSelect={() => set(chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])} />
        ))}
      </div>
    );
  }
  if (kind === "date") {
    if (rule.cond === "between") {
      const v = (rule.value ?? {}) as { start?: string; end?: string };
      return (
        <div className="db-rule-row">
          <input type="date" className="db-input" value={v.start ?? ""} onChange={(e) => set({ ...v, start: e.target.value })} />
          <input type="date" className="db-input" value={v.end ?? ""} onChange={(e) => set({ ...v, end: e.target.value })} />
        </div>
      );
    }
    if (rule.cond === "relative") {
      const v = (rule.value ?? {}) as { relative?: string };
      return (
        <div className="db-rule-row">
          <select className="db-input" data-testid="db-rule-relative" value={v.relative ?? ""} onChange={(e) => set({ relative: e.target.value })}>
            <option value="" disabled>
              Choose a range…
            </option>
            {RELATIVE_RANGES.filter((r) => r.id.includes("_")).map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    const v = (rule.value ?? {}) as { date?: string; relative?: string };
    const mode = v.relative ?? (v.date ? "exact" : "");
    return (
      <div className="db-rule-row">
        <select className="db-input" value={mode} data-testid="db-rule-date-mode" onChange={(e) => (e.target.value === "exact" ? set({ date: new Date().toISOString().slice(0, 10) }) : set({ relative: e.target.value }))}>
          <option value="" disabled>
            Choose…
          </option>
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
          <option value="yesterday">Yesterday</option>
          <option value="exact">Exact date</option>
        </select>
        {mode === "exact" && <input type="date" className="db-input" data-testid="db-rule-date" value={v.date ?? ""} onChange={(e) => set({ date: e.target.value })} />}
      </div>
    );
  }
  return (
    <div className="db-rule-row">
      <input className="db-input" autoFocus type={kind === "number" ? "number" : "text"} placeholder="Type a value…" data-testid="db-rule-value" value={typeof rule.value === "string" || typeof rule.value === "number" ? String(rule.value) : ""} onChange={(e) => set(e.target.value)} />
    </div>
  );
}

export function AdvancedFilter({ m, group, depth, onChange, onDelete }: { m: DatabaseModel; group: FilterGroup; depth: number; onChange: (g: FilterGroup) => void; onDelete: () => void }) {
  const picker = usePopover<{ index: number | null }>();
  const update = (i: number, r: FilterRule | FilterGroup) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? r : x)) });
  const remove = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  return (
    <div className={`db-adv ${depth > 0 ? "is-nested" : ""}`} data-testid="db-adv-group">
      {group.rules.map((r, i) => (
        <div key={r.id} className="db-adv-row">
          <span className="db-adv-op">
            {i === 0 ? (
              "Where"
            ) : i === 1 ? (
              <select className="db-input db-adv-op-select" value={group.op} data-testid="db-adv-op" onChange={(e) => onChange({ ...group, op: e.target.value === "or" ? "or" : "and" })}>
                <option value="and">And</option>
                <option value="or">Or</option>
              </select>
            ) : group.op === "or" ? (
              "Or"
            ) : (
              "And"
            )}
          </span>
          {r.kind === "group" ? (
            <AdvancedFilter m={m} group={r} depth={depth + 1} onChange={(g) => update(i, g)} onDelete={() => remove(i)} />
          ) : (
            <AdvancedRule m={m} rule={r} onChange={(x) => update(i, x)} onDelete={() => remove(i)} />
          )}
        </div>
      ))}
      {!group.rules.length && <div className="db-empty-note">No filter rules. Add one below.</div>}
      <div className="db-adv-actions">
        <button type="button" className="db-btn" data-testid="db-adv-add-rule" onClick={(e) => picker.open(e.currentTarget, { index: null })}>
          <Icon name="plus" size={14} /> Add filter rule
        </button>
        {depth < 2 && (
          <button type="button" className="db-btn" data-testid="db-adv-add-group" onClick={() => onChange({ ...group, rules: [...group.rules, { kind: "group", id: newId(), op: group.op === "and" ? "or" : "and", rules: [] }] })}>
            <Icon name="plus" size={14} /> Add filter group
          </button>
        )}
        <span className="db-flex" />
        <button type="button" className="db-btn is-danger" onClick={onDelete}>
          {depth === 0 ? "Delete filter" : "Delete group"}
        </button>
      </div>
      {picker.state && (
        <PropPicker m={m} anchor={picker.state.anchor} onClose={picker.close} onPick={(p) => {
          picker.close();
          onChange({ ...group, rules: [...group.rules, newRule(m, p.id)] });
        }} />
      )}
    </div>
  );
}

function AdvancedRule({ m, rule, onChange, onDelete }: { m: DatabaseModel; rule: FilterRule; onChange: (r: FilterRule) => void; onDelete: () => void }) {
  const prop = m.schema.find((p) => p.id === rule.prop);
  const value = usePopover();
  const kind = prop ? kindOf(m.ctx, prop) : "text";
  const conds = condsFor(kind);
  return (
    <div className="db-adv-rule" data-testid="db-adv-rule">
      <select className="db-input" value={rule.prop} onChange={(e) => onChange({ ...newRule(m, e.target.value), id: rule.id })}>
        {!prop && <option value={rule.prop}>Deleted property</option>}
        {m.schema.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select className="db-input" value={rule.cond} data-testid="db-adv-cond" onChange={(e) => onChange({ ...rule, cond: e.target.value as FilterCond, ...(sameValueShape(rule.cond, e.target.value as FilterCond) ? {} : { value: undefined }) } as FilterRule)}>
        {conds.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {prop && !isValueless(rule.cond) ? (
        kind === "text" || kind === "number" || kind === "files" ? (
          <input className="db-input" type={kind === "number" ? "number" : "text"} placeholder="Value" data-testid="db-adv-value" value={typeof rule.value === "string" || typeof rule.value === "number" ? String(rule.value) : ""} onChange={(e) => onChange({ ...rule, value: e.target.value })} />
        ) : (
          <button type="button" className="db-input db-adv-value-btn" data-testid="db-adv-value-btn" onClick={(e) => value.open(e.currentTarget)}>
            {summary(m, rule, prop) || "Select…"}
          </button>
        )
      ) : (
        <span />
      )}
      <button type="button" className="db-icon-btn" aria-label="Delete rule" onClick={onDelete}>
        <Icon name="trash" size={14} />
      </button>
      {value.state && prop && (
        <Popover anchor={value.state.anchor} onClose={value.close} width={280}>
          <div className="db-menu">
            <ValueInput m={m} prop={prop} kind={kind} rule={rule} onChange={onChange} />
          </div>
        </Popover>
      )}
    </div>
  );
}

export function SortEditor({ m, view, anchor, onClose }: { m: DatabaseModel; view: View; anchor: Anchor; onClose: () => void }) {
  const picker = usePopover();
  const [drag, setDrag] = useState<string | null>(null);
  const set = (sorts: SortRule[]) => updateView(m.doc, view.id, { sorts });
  return (
    <Popover anchor={anchor} onClose={onClose} width={380} testId="db-sort-editor">
      <div className="db-menu">
        {view.sorts.map((s, i) => (
          <div
            key={s.id}
            className="db-sort-row"
            data-testid="db-sort-row"
            draggable
            onDragStart={() => setDrag(s.id)}
            onDragOver={(e) => drag && drag !== s.id && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!drag) return;
              const list = view.sorts.filter((x) => x.id !== drag);
              const moved = view.sorts.find((x) => x.id === drag)!;
              const at = list.findIndex((x) => x.id === s.id);
              const r = e.currentTarget.getBoundingClientRect();
              list.splice(e.clientY < r.top + r.height / 2 ? at : at + 1, 0, moved);
              set(list);
              setDrag(null);
            }}
          >
            <span className="db-drag-handle is-visible">
              <Icon name="drag" size={12} />
            </span>
            <select className="db-input" value={s.prop} data-testid="db-sort-prop" onChange={(e) => set(view.sorts.map((x, j) => (j === i ? { ...x, prop: e.target.value } : x)))}>
              {m.schema.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="db-input" value={s.dir} data-testid="db-sort-dir" onChange={(e) => set(view.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value === "desc" ? "desc" : "asc" } : x)))}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button type="button" className="db-icon-btn" aria-label="Remove sort" onClick={() => set(view.sorts.filter((_, j) => j !== i))}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        {view.sorts.length > 0 && <MenuSeparator />}
        <MenuItem icon="plus" label="Add sort" testId="db-add-sort" onSelect={(el) => picker.open(el)} />
        {view.sorts.length > 0 && <MenuItem icon="trash" label="Delete sort" danger onSelect={() => {
          set([]);
          onClose();
        }} />}
      </div>
      {picker.state && (
        <PropPicker m={m} title="Sort by" anchor={picker.state.anchor} onClose={picker.close} onPick={(p) => {
          picker.close();
          set([...view.sorts, { id: newId(), prop: p.id, dir: "asc" }]);
        }} />
      )}
    </Popover>
  );
}

registerCss(
  "filters",
  `
.db-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 0 8px; }
.db-chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 10px; border-radius: 12px; border: none; background: var(--n-pill); color: var(--n-text-2); font-size: var(--n-t-small, 12px); font-weight: var(--n-w-medium, 500); cursor: default; max-width: 280px; white-space: nowrap; }
.db-chip:hover { background: var(--n-tool-hover); color: var(--n-text); }
.db-chip.is-on { background: var(--n-selected); color: var(--n-text); }
.db-chip.is-add { border-color: transparent; color: var(--n-text-3); }
.db-chip.is-add:hover { color: var(--n-text-2); }
.db-chip-name { font-weight: 500; }
.db-chip-value { overflow: hidden; text-overflow: ellipsis; }
.db-chip-sep { width: 0.5px; height: 16px; background: var(--n-divider); }
.db-rule { padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.db-rule-head { display: flex; align-items: center; gap: 4px; padding: 0 2px; font-size: 13px; color: var(--n-text-2); }
.db-rule-prop { font-weight: 500; }
.db-rule-row { display: flex; gap: 6px; padding: 2px; }
.db-rule-options { max-height: 260px; overflow: auto; }
.db-flex { flex: 1; }
.db-adv { display: flex; flex-direction: column; gap: 6px; padding: 8px; min-width: 0; flex: 1; }
.db-adv.is-nested { background: var(--n-raised); box-shadow: inset 0 0 0 1px var(--n-group-border); border: none; border-radius: var(--n-r-tile, 8px); padding: 6px; }
.db-adv-row { display: flex; align-items: flex-start; gap: 6px; }
.db-adv-op { width: 64px; flex: none; font-size: 13px; color: var(--n-text-2); height: 28px; display: flex; align-items: center; padding-left: 4px; }
.db-adv-op-select { width: 64px; padding: 0 4px; }
.db-adv-rule { display: grid; grid-template-columns: 140px 130px 1fr 24px; gap: 6px; align-items: center; flex: 1; min-width: 0; }
.db-adv-value-btn { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
.db-adv-actions { display: flex; gap: 4px; align-items: center; }
.db-sort-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; }
.db-sort-row .db-input { flex: 1; }
.db-drag-handle.is-visible { opacity: 1; cursor: grab; }
`,
);
