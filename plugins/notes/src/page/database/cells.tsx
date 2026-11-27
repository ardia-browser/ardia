import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageMeta } from "../../shared/model";
import {
  createRow,
  readSchema,
  COLORS,
  DATE_FORMATS,
  STATUS_GROUPS,
  addOption,
  addMonths,
  cleanFiles,
  dateValue,
  deleteOption,
  filesValue,
  formatDate,
  formatDay,
  formatNumber,
  fToText,
  fvalue,
  idsValue,
  isEditable,
  isError,
  moveOption,
  multiValue,
  numberValue,
  optionOf,
  parseDateString,
  selectValue,
  startOfDay,
  startOfWeek,
  addDays,
  toDateString,
  updateOption,
  updateProperty,
  type Color,
  type DateValue,
  type FileValue,
  type FValue,
  type Property,
  type SelectOption,
  type StatusGroup,
} from "../../shared/database";
import type { DatabaseModel } from "./data";
import type { Actions } from "./actions";
import { Icon } from "./icons";
import { Avatar, Menu, MenuItem, MenuLabel, MenuSeparator, Popover, StatusDot, Tag, Toggle, usePopover, type Anchor } from "./ui";

export function useFileUrl(m: Pick<DatabaseModel, "client" | "workspace">, ref: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!ref) {
      setUrl(null);
      return;
    }
    if (/^https?:\/\//.test(ref) || ref.startsWith("data:image/")) {
      setUrl(ref);
      return;
    }
    m.client.fileUrl(m.workspace, ref).then(
      (u) => alive && setUrl(u),
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
    };
  }, [m.client, m.workspace, ref]);
  return url;
}

export function RowIcon({ m, row, size = 16 }: { m: DatabaseModel; row: PageMeta; size?: number }) {
  const file = row.icon.startsWith("file:") ? row.icon : null;
  const url = useFileUrl(m, file);
  if (!row.icon) return null;
  if (file) return url ? <img className="db-row-icon-img" src={url} width={size} height={size} alt="" /> : null;
  return (
    <span className="db-row-icon" style={{ fontSize: size - 1 }}>
      {row.icon}
    </span>
  );
}

function Bar({ value, prop }: { value: number; prop: Property }) {
  const pct = Math.max(0, Math.min(1, value / (prop.divideBy || 100)));
  return (
    <span className="db-num-bar">
      {prop.showNumber && <span className="db-num-text">{formatNumber(value, prop.format)}</span>}
      <span className="db-bar">
        <span className={`db-bar-fill b-${prop.barColor}`} style={{ width: `${pct * 100}%` }} />
      </span>
    </span>
  );
}

function Ring({ value, prop }: { value: number; prop: Property }) {
  const pct = Math.max(0, Math.min(1, value / (prop.divideBy || 100)));
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="db-num-ring">
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="db-ring-track" />
        <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className={`db-ring-fill b-${prop.barColor}`} strokeDasharray={`${pct * c} ${c}`} transform="rotate(-90 10 10)" strokeLinecap="round" />
      </svg>
      {prop.showNumber && <span className="db-num-text">{formatNumber(value, prop.format)}</span>}
    </span>
  );
}

function FileChip({ m, file }: { m: DatabaseModel; file: FileValue }) {
  const isImage = file.type.startsWith("image/");
  const url = useFileUrl(m, isImage ? file.ref : null);
  return isImage && url ? <img className="db-file-thumb" src={url} alt={file.name} /> : <span className="db-file-chip">{file.name}</span>;
}

export function PersonChip({ m, id, compact }: { m: DatabaseModel; id: string; compact?: boolean }) {
  const p = m.people.get(id) ?? { id, name: "Someone", color: "#888" };
  return (
    <span className="db-person" title={p.name}>
      <Avatar name={p.name} color={p.color} size={18} />
      {!compact && <span className="db-person-name">{p.name}</span>}
    </span>
  );
}

export function FValueView({ value, prop }: { value: FValue; prop: Property }) {
  if (value === null) return null;
  if (typeof value === "boolean") return <span className={`db-check ${value ? "is-on" : ""}`}>{value && <Icon name="check" size={12} strokeWidth={2} />}</span>;
  if (Array.isArray(value)) {
    const items = value.filter((x) => x !== null && x !== "");
    if (items.every((x) => typeof x === "string")) return <span className="db-tags">{items.map((x, i) => <Tag key={i} color="default">{x as string}</Tag>)}</span>;
    return <span className="db-text">{fToText(items, prop)}</span>;
  }
  return <span className="db-text">{fToText(value, prop)}</span>;
}

export function CellView({ m, row, prop, wrap = false, card = false }: { m: DatabaseModel; row: PageMeta; prop: Property; wrap?: boolean; card?: boolean }): ReactNode {
  const cls = `db-cell-value ${wrap ? "is-wrap" : ""}`;
  switch (prop.type) {
    case "title":
      return (
        <span className={`${cls} db-title-value`}>
          <RowIcon m={m} row={row} />
          <span className={row.title ? "" : "db-untitled"}>{row.title || "Untitled"}</span>
        </span>
      );
    case "text":
      return <span className={cls}>{typeof row.props[prop.id] === "string" ? (row.props[prop.id] as string) : ""}</span>;
    case "url":
    case "email":
    case "phone": {
      const v = typeof row.props[prop.id] === "string" ? (row.props[prop.id] as string) : "";
      return <span className={`${cls} db-link`}>{v}</span>;
    }
    case "number": {
      const n = numberValue(row, prop);
      if (n === null) return null;
      if (prop.display === "bar") return <Bar value={n} prop={prop} />;
      if (prop.display === "ring") return <Ring value={n} prop={prop} />;
      return <span className={`${cls} db-num`}>{formatNumber(n, prop.format)}</span>;
    }
    case "select": {
      const o = selectValue(row, prop);
      return o ? <span className={cls}><Tag color={o.color}>{o.name}</Tag></span> : null;
    }
    case "status": {
      const o = selectValue(row, prop);
      return o ? (
        <span className={cls}>
          <Tag color={o.color} className="db-status-tag">
            <StatusDot color={o.color} />
            {o.name}
          </Tag>
        </span>
      ) : null;
    }
    case "multi_select": {
      const list = multiValue(row, prop);
      return list.length ? (
        <span className={`${cls} db-tags ${wrap || card ? "is-wrap" : ""}`}>
          {list.map((o) => (
            <Tag key={o.id} color={o.color}>
              {o.name}
            </Tag>
          ))}
        </span>
      ) : null;
    }
    case "date":
    case "created_time":
    case "edited_time": {
      const d = dateValue(row, prop);
      const f = d ? fvalue(m.ctx, row, prop) : null;
      return d ? <span className={cls}>{formatDate(f as never, prop, m.ctx.now)}</span> : null;
    }
    case "person":
    case "created_by":
    case "edited_by": {
      const ids = idsValue(row, prop);
      return ids.length ? (
        <span className={`${cls} db-people ${wrap || card ? "is-wrap" : ""}`}>
          {ids.map((id) => (
            <PersonChip key={id} m={m} id={id} compact={ids.length > 2 && !wrap && !card} />
          ))}
        </span>
      ) : null;
    }
    case "files": {
      const files = filesValue(row, prop);
      return files.length ? (
        <span className={`${cls} db-files`}>
          {files.map((f) => (
            <FileChip key={f.ref} m={m} file={f} />
          ))}
        </span>
      ) : null;
    }
    case "checkbox":
      return (
        <span className={`db-check ${row.props[prop.id] === true ? "is-on" : ""}`} data-testid="db-checkbox">
          {row.props[prop.id] === true && <Icon name="check" size={12} strokeWidth={2} />}
        </span>
      );
    case "relation": {
      const ids = idsValue(row, prop);
      const pages = ids.map((id) => m.store.pages.get(id)).filter((p): p is PageMeta => !!p && !p.deleted && !p.archivedAt);
      return pages.length ? (
        <span className={`${cls} db-relations ${wrap || card ? "is-wrap" : ""}`}>
          {pages.map((p) => (
            <span key={p.id} className="db-relation-chip">
              <Icon name="page" size={14} />
              <span>{p.title || "Untitled"}</span>
            </span>
          ))}
        </span>
      ) : null;
    }
    case "id": {
      const n = numberValue(row, prop);
      return n === null ? null : <span className={`${cls} db-num-left`}>{prop.prefix ? `${prop.prefix}-${n}` : n}</span>;
    }
    case "formula":
    case "rollup": {
      const v = fvalue(m.ctx, row, prop);
      if (isError(v)) return <span className={`${cls} db-error`} title={v.error}>{v.error}</span>;
      if (typeof v === "number" && prop.type === "rollup" && prop.format && prop.format !== "number") return <span className={`${cls} db-num`}>{formatNumber(v, prop.format)}</span>;
      if (typeof v === "number") return <span className={`${cls} db-num`}>{prop.display === "bar" ? <Bar value={v} prop={prop} /> : prop.display === "ring" ? <Ring value={v} prop={prop} /> : formatNumber(v, prop.format)}</span>;
      return <span className={cls}><FValueView value={v} prop={prop} /></span>;
    }
  }
}

export const isEmptyCell = (m: DatabaseModel, row: PageMeta, prop: Property) => {
  if (prop.type === "title") return !row.title;
  if (prop.type === "checkbox") return false;
  if (prop.type === "formula" || prop.type === "rollup") {
    const v = fvalue(m.ctx, row, prop);
    return v === null || v === "" || (Array.isArray(v) && !v.length) || isError(v);
  }
  if (prop.type === "created_time" || prop.type === "edited_time" || prop.type === "created_by" || prop.type === "edited_by") return false;
  const v = row.props[prop.id];
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
};

type EditorProps = { m: DatabaseModel; actions: Actions; row: PageMeta; prop: Property; anchor: Anchor; onClose: () => void; initialText?: string };

export function CellEditor(props: EditorProps) {
  const { prop } = props;
  if (!isEditable(prop.type)) return null;
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
    case "number":
      return <TextEditor {...props} />;
    case "select":
    case "multi_select":
    case "status":
      return <OptionEditor {...props} />;
    case "date":
      return <DateEditorPopover {...props} />;
    case "person":
      return <PersonEditor {...props} />;
    case "files":
      return <FilesEditor {...props} />;
    case "relation":
      return <RelationEditor {...props} />;
    default:
      return null;
  }
}

function TextEditor({ m, actions, row, prop, anchor, onClose, initialText }: EditorProps) {
  const initial = prop.type === "title" ? row.title : prop.type === "number" ? (numberValue(row, prop)?.toString() ?? "") : typeof row.props[prop.id] === "string" ? (row.props[prop.id] as string) : "";
  const [text, setText] = useState(initialText ?? initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (text !== initial) actions.setValue(row.id, prop, prop.type === "number" ? (text.trim() === "" ? null : text) : text);
    onClose();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  const width = anchor instanceof HTMLElement ? Math.max(anchor.getBoundingClientRect().width, prop.type === "title" ? 240 : 200) : 240;
  const open = prop.type === "url" || prop.type === "email" || prop.type === "phone";
  return (
    <Popover anchor={anchor} onClose={commit} placement="over" className="db-text-editor" style={{ width }} testId="db-text-editor">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        className={`db-textarea ${prop.type === "number" ? "is-num" : ""}`}
        data-testid="db-cell-input"
        inputMode={prop.type === "number" ? "decimal" : undefined}
        onChange={(e) => setText(prop.type === "title" ? e.target.value.replace(/\n/g, "") : e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.shiftKey && prop.type === "text")) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {open && text && (
        <button
          type="button"
          className="db-open-link"
          onClick={() => {
            const url = prop.type === "email" ? `mailto:${text}` : prop.type === "phone" ? `tel:${text}` : /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
            if (/^(https?|mailto|tel):/i.test(url)) m.client.call("openUrl", { url }).catch(() => window.open(url, "_blank", "noopener"));
          }}
        >
          <Icon name="arrowRight" size={14} /> Open
        </button>
      )}
    </Popover>
  );
}

export function OptionMenu({ m, prop, option, anchor, onClose }: { m: DatabaseModel; prop: Property; option: SelectOption; anchor: Anchor; onClose: () => void }) {
  const [name, setName] = useState(option.name);
  return (
    <Popover anchor={anchor} onClose={() => {
      if (name.trim() && name !== option.name) updateOption(m.schemaDoc, prop.id, option.id, { name: name.trim() });
      onClose();
    }} placement="right-start" width={220} testId="db-option-menu">
      <Menu autoFocus={false}>
        <div className="db-menu-pad">
          <input
            className="db-input"
            autoFocus
            value={name}
            data-testid="db-option-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (name.trim()) updateOption(m.schemaDoc, prop.id, option.id, { name: name.trim() });
                onClose();
              }
            }}
          />
        </div>
        <MenuItem icon="trash" label="Delete" danger testId="db-option-delete" onSelect={() => {
          deleteOption(m.schemaDoc, prop.id, option.id);
          onClose();
        }} />
        <MenuSeparator />
        <MenuLabel>Colors</MenuLabel>
        {COLORS.map((c) => (
          <MenuItem key={c} icon={<span className={`db-swatch c-${c}`} />} label={c[0]!.toUpperCase() + c.slice(1)} checked={option.color === c} onSelect={() => updateOption(m.schemaDoc, prop.id, option.id, { color: c })} />
        ))}
      </Menu>
    </Popover>
  );
}

function OptionEditor({ m, actions, row, prop, anchor, onClose }: EditorProps) {
  const multi = prop.type === "multi_select";
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const optionMenu = usePopover<SelectOption>();
  const dragging = useRef<string | null>(null);
  const selected = multi ? idsValue(row, prop) : [String(row.props[prop.id] ?? "")].filter(Boolean);
  const live = m.store.pages.get(row.id) ?? row;
  const current = multi ? idsValue(live, prop) : [String(live.props[prop.id] ?? "")].filter(Boolean);
  const q = query.trim().toLowerCase();
  const matches = prop.options.filter((o) => o.name.toLowerCase().includes(q));
  const exact = prop.options.some((o) => o.name.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact && !m.locked;
  const items = [...matches.map((o) => ({ kind: "option" as const, o })), ...(canCreate ? [{ kind: "create" as const }] : [])];
  const pick = (o: SelectOption) => {
    if (multi) {
      const has = current.includes(o.id);
      actions.setValue(row.id, prop, has ? current.filter((x) => x !== o.id) : [...current, o.id]);
      setQuery("");
    } else {
      actions.setValue(row.id, prop, current[0] === o.id ? null : o.id);
      onClose();
    }
  };
  const create = () => {
    const name = query.trim();
    if (!name) return;
    const id = addOption(m.schemaDoc, prop.id, name, prop.type === "status" ? { group: "todo" } : {});
    if (multi) actions.setValue(row.id, prop, [...current, id]);
    else {
      actions.setValue(row.id, prop, id);
      onClose();
    }
    setQuery("");
  };
  void selected;
  const groups: (StatusGroup | null)[] = prop.type === "status" ? STATUS_GROUPS.map((g) => g.id) : [null];
  const renderOption = (o: SelectOption) => {
    const index = items.findIndex((it) => it.kind === "option" && it.o.id === o.id);
    return (
      <div
        key={o.id}
        data-menu-item=""
        data-testid="db-option"
        data-option={o.name}
        className={`db-item db-option-row ${index === active ? "is-active" : ""}`}
        onMouseEnter={() => setActive(index)}
        onClick={() => pick(o)}
        draggable={!m.locked && !q}
        onDragStart={(e) => {
          dragging.current = o.id;
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (dragging.current && dragging.current !== o.id) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const from = dragging.current;
          dragging.current = null;
          if (!from || from === o.id) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          const list = prop.options.filter((x) => x.id !== from);
          const i = list.findIndex((x) => x.id === o.id);
          const after = before ? (list[i - 1]?.group === o.group || prop.type !== "status" ? list[i - 1]?.id ?? null : null) : o.id;
          moveOption(m.schemaDoc, prop.id, from, after, o.group);
        }}
      >
        {!m.locked && <span className="db-drag-handle"><Icon name="drag" size={12} /></span>}
        <span className="db-item-label">
          {prop.type === "status" ? (
            <Tag color={o.color} className="db-status-tag">
              <StatusDot color={o.color} />
              {o.name}
            </Tag>
          ) : (
            <Tag color={o.color}>{o.name}</Tag>
          )}
        </span>
        {current.includes(o.id) && <Icon name="check" size={14} className="db-item-check" />}
        {!m.locked && (
          <button
            type="button"
            className="db-icon-btn db-option-more"
            data-testid="db-option-more"
            onClick={(e) => {
              e.stopPropagation();
              optionMenu.open(e.currentTarget, o);
            }}
          >
            <Icon name="more" size={14} />
          </button>
        )}
      </div>
    );
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="over" width={300} testId="db-option-editor">
      <div className="db-option-head">
        {current.map((id) => {
          const o = optionOf(prop, id);
          return o ? (
            <Tag key={id} color={o.color} onRemove={() => actions.setValue(row.id, prop, multi ? current.filter((x) => x !== id) : null)}>
              {o.name}
            </Tag>
          ) : null;
        })}
        <input
          className="db-option-search"
          autoFocus
          value={query}
          data-testid="db-option-search"
          placeholder={current.length ? "" : prop.type === "status" ? "Search for an option…" : "Search for an option…"}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const it = items[active];
              if (it?.kind === "option") pick(it.o);
              else if (it?.kind === "create") create();
            } else if (e.key === "Backspace" && !query && current.length && multi) actions.setValue(row.id, prop, current.slice(0, -1));
          }}
        />
      </div>
      <div className="db-menu db-option-list">
        <MenuLabel>{canCreate || matches.length ? "Select an option or create one" : "No options"}</MenuLabel>
        {groups.map((g) => {
          const list = matches.filter((o) => (g ? (o.group ?? "todo") === g : true));
          if (g && !list.length && q) return null;
          return (
            <div key={g ?? "all"}>
              {g && <div className="db-menu-label db-status-group">{STATUS_GROUPS.find((x) => x.id === g)!.name}</div>}
              {list.map(renderOption)}
            </div>
          );
        })}
        {canCreate && (
          <div data-menu-item="" data-testid="db-option-create" className={`db-item ${active === items.length - 1 ? "is-active" : ""}`} onMouseEnter={() => setActive(items.length - 1)} onClick={create}>
            <span className="db-item-label">
              Create <Tag color="default">{query.trim()}</Tag>
            </span>
          </div>
        )}
      </div>
      {optionMenu.state && <OptionMenu m={m} prop={m.schema.find((p) => p.id === prop.id) ?? prop} option={optionMenu.state.value} anchor={optionMenu.state.anchor} onClose={optionMenu.close} />}
    </Popover>
  );
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function MonthGrid({ month, selected, range, onPick }: { month: number; selected: number | null; range?: [number, number] | null; onPick: (day: number) => void }) {
  const first = new Date(month);
  const start = startOfWeek(new Date(first.getFullYear(), first.getMonth(), 1).getTime());
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return (
    <div className="db-month">
      {WEEKDAYS.map((d) => (
        <span key={d} className="db-month-wd">
          {d}
        </span>
      ))}
      {days.map((d) => {
        const inMonth = new Date(d).getMonth() === first.getMonth();
        const isSel = selected !== null && startOfDay(selected) === d;
        const inRange = range && d >= startOfDay(range[0]) && d <= startOfDay(range[1]);
        return (
          <button
            type="button"
            key={d}
            data-testid="db-day"
            data-day={toDateString(d)}
            className={`db-month-day ${inMonth ? "" : "is-out"} ${d === today ? "is-today" : ""} ${isSel ? "is-sel" : ""} ${inRange ? "is-range" : ""}`}
            onClick={() => onPick(d)}
          >
            {new Date(d).getDate()}
          </button>
        );
      })}
    </div>
  );
}

export function DateEditor({ value, prop, onChange, m, allowSettings = true }: { value: DateValue | null; prop: Property; onChange: (v: DateValue | null) => void; m: DatabaseModel; allowSettings?: boolean }) {
  const start = parseDateString(value?.start);
  const end = parseDateString(value?.end);
  const [month, setMonth] = useState(() => startOfDay(start?.ms ?? Date.now()));
  const [editingEnd, setEditingEnd] = useState(false);
  const hasEnd = value?.end !== undefined;
  const hasTime = start?.time ?? false;
  const fmtMenu = usePopover();
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const show = (p: { ms: number; time: boolean } | null) => (p ? formatDay(p.ms, prop.dateFormat === "relative" ? "full" : prop.dateFormat) : "");
  const showTime = (p: { ms: number; time: boolean } | null) => (p ? toDateString(p.ms, true).slice(11) : "");
  useEffect(() => {
    setStartText(show(start));
    setEndText(show(end));
  }, [value?.start, value?.end, prop.dateFormat]);
  const withTime = (day: number, base: { ms: number; time: boolean } | null) => {
    if (!hasTime) return toDateString(day);
    const b = new Date(base?.ms ?? Date.now());
    return toDateString(new Date(new Date(day).getFullYear(), new Date(day).getMonth(), new Date(day).getDate(), base ? b.getHours() : 9, base ? b.getMinutes() : 0).getTime(), true);
  };
  const pick = (day: number) => {
    if (hasEnd && editingEnd) {
      const s = start?.ms ?? day;
      const [a, b] = day < startOfDay(s) ? [day, s] : [s, day];
      onChange({ start: withTime(a, start), end: withTime(b, end ?? start) });
      setEditingEnd(false);
    } else if (hasEnd) {
      const e = end?.ms ?? day;
      onChange({ start: withTime(day, start), end: withTime(Math.max(day, startOfDay(e)), end) });
      setEditingEnd(true);
    } else onChange({ start: withTime(day, start) });
  };
  const parseTyped = (text: string, base: { ms: number; time: boolean } | null) => {
    const iso = parseDateString(text.trim());
    const ms = iso?.ms ?? Date.parse(text);
    if (!Number.isFinite(ms)) return null;
    return withTime(startOfDay(ms), base);
  };
  const setTime = (which: "start" | "end", text: string) => {
    const m2 = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text.trim());
    if (!m2) return;
    let h = Number(m2[1]);
    if (m2[3]) h = (h % 12) + (m2[3].toLowerCase() === "pm" ? 12 : 0);
    const base = which === "start" ? start : end;
    if (!base) return;
    const d = new Date(base.ms);
    const ms = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, Number(m2[2])).getTime();
    if (which === "start") onChange({ start: toDateString(ms, true), ...(value?.end ? { end: value.end } : {}) });
    else onChange({ start: value!.start, end: toDateString(ms, true) });
  };
  return (
    <div className="db-date-editor" data-testid="db-date-editor">
      <div className="db-date-inputs">
        <div className={`db-date-field ${!editingEnd ? "is-focus" : ""}`} onClick={() => setEditingEnd(false)}>
          <input className="db-input" data-testid="db-date-start" value={startText} placeholder="Start" onChange={(e) => setStartText(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter") {
              const s = parseTyped(startText, start);
              if (s) {
                onChange({ start: s, ...(value?.end ? { end: value.end } : {}) });
                setMonth(parseDateString(s)!.ms);
              }
            }
          }} />
          {hasTime && <input className="db-input db-time" data-testid="db-time-start" defaultValue={showTime(start)} key={`s${value?.start}`} onBlur={(e) => setTime("start", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setTime("start", (e.target as HTMLInputElement).value)} />}
        </div>
        {hasEnd && (
          <div className={`db-date-field ${editingEnd ? "is-focus" : ""}`} onClick={() => setEditingEnd(true)}>
            <input className="db-input" data-testid="db-date-end" value={endText} placeholder="End" onChange={(e) => setEndText(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && value) {
                const s = parseTyped(endText, end);
                if (s) onChange({ start: value.start, end: s });
              }
            }} />
            {hasTime && <input className="db-input db-time" defaultValue={showTime(end)} key={`e${value?.end}`} onBlur={(e) => setTime("end", e.target.value)} />}
          </div>
        )}
      </div>
      <div className="db-month-head">
        <span className="db-month-title">{new Date(month).toLocaleString("en-US", { month: "long", year: "numeric" })}</span>
        <button type="button" className="db-link-btn" onClick={() => setMonth(startOfDay(Date.now()))}>
          Today
        </button>
        <button type="button" className="db-icon-btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button type="button" className="db-icon-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <MonthGrid month={month} selected={editingEnd ? end?.ms ?? null : start?.ms ?? null} range={start && end ? [start.ms, end.ms] : null} onPick={pick} />
      <div className="db-menu">
        <MenuSeparator />
        <MenuItem label="End date" right={<Toggle on={hasEnd} testId="db-end-toggle" onChange={(on) => {
          if (!value) {
            const today = toDateString(Date.now());
            onChange(on ? { start: today, end: today } : { start: today });
          } else onChange(on ? { start: value.start, end: value.start } : { start: value.start });
          setEditingEnd(on);
        }} />} />
        {allowSettings && <MenuItem label="Date format & timezone" chevron onSelect={(el) => fmtMenu.open(el)} />}
        <MenuItem label="Include time" right={<Toggle on={hasTime} testId="db-time-toggle" onChange={(on) => {
          const s = start?.ms ?? Date.now();
          const nextStart = on ? toDateString(new Date(new Date(s).setHours(9, 0, 0, 0)).getTime(), true) : toDateString(s);
          const nextEnd = end ? (on ? toDateString(new Date(new Date(end.ms).setHours(10, 0, 0, 0)).getTime(), true) : toDateString(end.ms)) : undefined;
          onChange({ start: nextStart, ...(nextEnd ? { end: nextEnd } : {}) });
        }} />} />
        <MenuSeparator />
        <MenuItem label="Clear" testId="db-date-clear" onSelect={() => onChange(null)} />
      </div>
      {fmtMenu.state && (
        <Popover anchor={fmtMenu.state.anchor} onClose={fmtMenu.close} placement="right-start" width={220}>
          <Menu>
            <MenuLabel>Date format</MenuLabel>
            {DATE_FORMATS.map((f) => (
              <MenuItem key={f.id} label={f.label} checked={prop.dateFormat === f.id} onSelect={() => updateProperty(m.schemaDoc, prop.id, { dateFormat: f.id })} />
            ))}
            <MenuSeparator />
            <MenuLabel>Time format</MenuLabel>
            {(["12", "24"] as const).map((f) => (
              <MenuItem key={f} label={f === "12" ? "12 hour" : "24 hour"} checked={prop.timeFormat === f} onSelect={() => updateProperty(m.schemaDoc, prop.id, { timeFormat: f })} />
            ))}
          </Menu>
        </Popover>
      )}
    </div>
  );
}

function DateEditorPopover({ m, actions, row, prop, anchor, onClose }: EditorProps) {
  const live = m.store.pages.get(row.id) ?? row;
  return (
    <Popover anchor={anchor} onClose={onClose} width={260} testId="db-date-popover">
      <DateEditor m={m} prop={prop} value={dateValue(live, prop)} onChange={(v) => actions.setValue(row.id, prop, v)} />
    </Popover>
  );
}

function PersonEditor({ m, actions, row, prop, anchor, onClose }: EditorProps) {
  const live = m.store.pages.get(row.id) ?? row;
  const current = idsValue(live, prop);
  const [query, setQuery] = useState("");
  const people = [...m.people.values()].filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} placement="over" width={280} testId="db-person-editor">
      <div className="db-option-head">
        {current.map((id) => (
          <Tag key={id} color="default" onRemove={() => actions.setValue(row.id, prop, current.filter((x) => x !== id))}>
            {m.people.get(id)?.name ?? "Someone"}
          </Tag>
        ))}
        <input className="db-option-search" autoFocus value={query} placeholder={current.length ? "" : "Search for a person…"} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Menu autoFocus={false} className="db-option-list">
        <MenuLabel>Select as many as you like</MenuLabel>
        {people.map((p) => (
          <MenuItem key={p.id} testId="db-person-option" icon={<Avatar name={p.name} color={p.color} size={20} />} label={p.name} checked={current.includes(p.id)} onSelect={() => actions.setValue(row.id, prop, current.includes(p.id) ? current.filter((x) => x !== p.id) : [...current, p.id])} />
        ))}
        {!people.length && <div className="db-empty-note">No people found</div>}
      </Menu>
    </Popover>
  );
}

function FilesEditor({ m, actions, row, prop, anchor, onClose }: EditorProps) {
  const live = m.store.pages.get(row.id) ?? row;
  const files = filesValue(live, prop);
  const input = useRef<HTMLInputElement | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const added: FileValue[] = [];
      for (const file of [...list].slice(0, 20)) {
        const ref = await m.client.upload(m.workspace, file, file.name);
        added.push({ ref, name: file.name.slice(0, 200), type: file.type.slice(0, 100) });
      }
      const now = filesValue(m.store.pages.get(row.id) ?? row, prop);
      actions.setValue(row.id, prop, cleanFiles([...now, ...added]));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={300} testId="db-files-editor">
      <Menu autoFocus={false}>
        {files.map((f, i) => (
          <MenuItem key={f.ref + i} icon={f.type.startsWith("image/") ? "image" : "files"} label={f.name} right={
            <button type="button" className="db-icon-btn" aria-label="Remove" onClick={(e) => {
              e.stopPropagation();
              actions.setValue(row.id, prop, files.filter((_, j) => j !== i));
            }}>
              <Icon name="trash" size={14} />
            </button>
          } onSelect={async () => {
            const url = /^https?:/.test(f.ref) ? f.ref : await m.client.fileUrl(m.workspace, f.ref);
            window.open(url, "_blank", "noopener");
          }} />
        ))}
        {files.length > 0 && <MenuSeparator />}
        <MenuItem icon="upload" label={busy ? "Uploading…" : "Upload a file"} testId="db-file-upload" onSelect={() => input.current?.click()} />
        <div className="db-menu-pad">
          <input
            className="db-input"
            placeholder="Paste a link and press Enter"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && /^https?:\/\/\S+$/.test(link.trim())) {
                const url = link.trim();
                const name = url.split("/").pop()?.split("?")[0] || url;
                actions.setValue(row.id, prop, [...files, { ref: url, name: name.slice(0, 200), type: /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url) ? "image/*" : "" }]);
                setLink("");
              }
            }}
          />
        </div>
      </Menu>
      <input ref={input} type="file" multiple hidden data-testid="db-file-input" onChange={(e) => void add(e.target.files)} />
    </Popover>
  );
}

function RelationEditor({ m, actions, row, prop, anchor, onClose }: EditorProps) {
  const live = m.store.pages.get(row.id) ?? row;
  const current = idsValue(live, prop);
  const [query, setQuery] = useState("");
  const targets = useMemo(() => m.store.children(prop.relation).filter((p) => !p.isTemplate), [m.store, m.rowVersion, prop.relation]);
  const q = query.trim().toLowerCase();
  const linked = current.map((id) => m.store.pages.get(id)).filter((p): p is PageMeta => !!p && !p.deleted && !p.archivedAt);
  const rest = targets.filter((p) => !current.includes(p.id) && (p.title || "Untitled").toLowerCase().includes(q)).slice(0, 100);
  const targetMeta = m.store.pages.get(prop.relation);
  const toggle = (id: string) => actions.setValue(row.id, prop, current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  return (
    <Popover anchor={anchor} onClose={onClose} width={340} testId="db-relation-editor">
      <div className="db-menu-pad">
        <input className="db-input" autoFocus value={query} placeholder={`Link or create a page in ${targetMeta?.title || "Untitled"}…`} data-testid="db-relation-search" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter" && rest[0]) toggle(rest[0].id);
        }} />
      </div>
      <Menu autoFocus={false} className="db-option-list">
        {linked.length > 0 && <MenuLabel>Linked</MenuLabel>}
        {linked.map((p) => (
          <MenuItem key={p.id} icon="page" label={p.title || "Untitled"} right={<Icon name="x" size={12} />} onSelect={() => toggle(p.id)} />
        ))}
        <MenuLabel>{q ? "Results" : "Pages"}</MenuLabel>
        {rest.map((p) => (
          <MenuItem key={p.id} testId="db-relation-option" icon="page" label={p.title || "Untitled"} right={<Icon name="plus" size={12} />} onSelect={() => toggle(p.id)} />
        ))}
        {q && (
          <MenuItem icon="plus" label={`New page "${query.trim()}"`} onSelect={() => {
            const ids = m.store.children(prop.relation);
            void ids;
            const id = (createRowIn(m, prop.relation, query.trim()));
            actions.setValue(row.id, prop, [...current, id]);
            setQuery("");
          }} />
        )}
      </Menu>
    </Popover>
  );
}

function createRowIn(m: DatabaseModel, database: string, title: string) {
  const doc = m.docFor(database);
  return createRow(m.tree, database, doc ? readSchema(doc) : [], { by: m.me.deviceId, title });
}

export function colorName(c: Color) {
  return c[0]!.toUpperCase() + c.slice(1);
}
