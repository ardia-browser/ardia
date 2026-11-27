import * as Y from "yjs";
import type { PageId } from "./protocol";
import { childrenOf, createPage, getPage, newId, orderBetween, pagesOf, setProp, type PageMeta } from "./model";

export type PropType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "files"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "formula"
  | "relation"
  | "rollup"
  | "created_time"
  | "created_by"
  | "edited_time"
  | "edited_by"
  | "id";

export const PROP_TYPES: { type: PropType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "status", label: "Status" },
  { type: "date", label: "Date" },
  { type: "person", label: "Person" },
  { type: "files", label: "Files & media" },
  { type: "checkbox", label: "Checkbox" },
  { type: "url", label: "URL" },
  { type: "email", label: "Email" },
  { type: "phone", label: "Phone" },
  { type: "formula", label: "Formula" },
  { type: "relation", label: "Relation" },
  { type: "rollup", label: "Rollup" },
  { type: "created_time", label: "Created time" },
  { type: "created_by", label: "Created by" },
  { type: "edited_time", label: "Last edited time" },
  { type: "edited_by", label: "Last edited by" },
  { type: "id", label: "ID" },
];

export const typeLabel = (type: PropType) => (type === "title" ? "Title" : PROP_TYPES.find((p) => p.type === type)?.label ?? type);

export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type Color = (typeof COLORS)[number];

export type StatusGroup = "todo" | "doing" | "done";
export const STATUS_GROUPS: { id: StatusGroup; name: string; color: Color }[] = [
  { id: "todo", name: "To-do", color: "gray" },
  { id: "doing", name: "In progress", color: "blue" },
  { id: "done", name: "Complete", color: "green" },
];

export type SelectOption = { id: string; name: string; color: Color; order: string; group?: StatusGroup };

export type NumberFormat = "number" | "commas" | "percent" | "dollar" | "euro" | "pound" | "yen" | "rupee" | "won" | "yuan" | "franc" | "real" | "ruble";
export const NUMBER_FORMATS: { id: NumberFormat; label: string }[] = [
  { id: "number", label: "Number" },
  { id: "commas", label: "Number with commas" },
  { id: "percent", label: "Percent" },
  { id: "dollar", label: "US dollar" },
  { id: "euro", label: "Euro" },
  { id: "pound", label: "Pound" },
  { id: "yen", label: "Yen" },
  { id: "rupee", label: "Rupee" },
  { id: "won", label: "Won" },
  { id: "yuan", label: "Yuan" },
  { id: "franc", label: "Swiss franc" },
  { id: "real", label: "Real" },
  { id: "ruble", label: "Ruble" },
];
const CURRENCY: Partial<Record<NumberFormat, string>> = { dollar: "USD", euro: "EUR", pound: "GBP", yen: "JPY", rupee: "INR", won: "KRW", yuan: "CNY", franc: "CHF", real: "BRL", ruble: "RUB" };

export type DateFormat = "full" | "short" | "mdy" | "dmy" | "ymd" | "relative";
export const DATE_FORMATS: { id: DateFormat; label: string }[] = [
  { id: "full", label: "Full date" },
  { id: "short", label: "Month/Day/Year" },
  { id: "dmy", label: "Day/Month/Year" },
  { id: "ymd", label: "Year/Month/Day" },
  { id: "relative", label: "Relative" },
];

export type RollupFn =
  | "show_original"
  | "count"
  | "count_values"
  | "unique"
  | "empty"
  | "not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "sum"
  | "avg"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest"
  | "latest"
  | "date_range";

export type CalcFn = Exclude<RollupFn, "show_original"> | "none";

export type Property = {
  id: string;
  name: string;
  type: PropType;
  order: string;
  options: SelectOption[];
  format: NumberFormat;
  display: "number" | "bar" | "ring";
  divideBy: number;
  barColor: Color;
  showNumber: boolean;
  dateFormat: DateFormat;
  timeFormat: "12" | "24" | "hidden";
  expression: string;
  relation: string;
  twoWay: boolean;
  backProp: string;
  rollupRelation: string;
  rollupTarget: string;
  rollupFn: RollupFn;
  prefix: string;
  nextId: number;
  description: string;
};

export const TITLE = "title";

export const schemaOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("schema");
export const viewsOf = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>("views");
export const viewMapOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("viewsById");
export const settingsOf = (doc: Y.Doc) => doc.getMap<unknown>("settings");
export const peopleOf = (doc: Y.Doc) => doc.getMap<unknown>("people");

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);
const byOrder = <T extends { order: string; id: string }>(a: T, b: T) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const TYPE_IDS = [...PROP_TYPES.map((p) => p.type), "title"] as PropType[];
const ROLLUP_FNS: RollupFn[] = ["show_original", "count", "count_values", "unique", "empty", "not_empty", "percent_empty", "percent_not_empty", "checked", "unchecked", "percent_checked", "percent_unchecked", "sum", "avg", "median", "min", "max", "range", "earliest", "latest", "date_range"];

function readOptions(entry: Y.Map<unknown>): SelectOption[] {
  const raw = entry.get("options");
  if (!(raw instanceof Y.Map)) return [];
  const out: SelectOption[] = [];
  raw.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const group = value.get("group");
    out.push({
      id,
      name: str(value.get("name")),
      color: oneOf(value.get("color"), COLORS, "default"),
      order: str(value.get("order"), id),
      ...(group === "todo" || group === "doing" || group === "done" ? { group } : {}),
    });
  });
  return out.sort(byOrder);
}

export function readProperty(entry: Y.Map<unknown>, id: string): Property {
  const type = id === TITLE ? "title" : oneOf(entry.get("type"), TYPE_IDS, "text");
  return {
    id,
    name: str(entry.get("name"), id === TITLE ? "Name" : ""),
    type,
    order: str(entry.get("order"), id === TITLE ? "" : id),
    options: readOptions(entry),
    format: oneOf(entry.get("format"), NUMBER_FORMATS.map((f) => f.id), "number"),
    display: oneOf(entry.get("display"), ["number", "bar", "ring"] as const, "number"),
    divideBy: num(entry.get("divideBy"), 100) || 100,
    barColor: oneOf(entry.get("barColor"), COLORS, "green"),
    showNumber: bool(entry.get("showNumber"), true),
    dateFormat: oneOf(entry.get("dateFormat"), DATE_FORMATS.map((f) => f.id), "full"),
    timeFormat: oneOf(entry.get("timeFormat"), ["12", "24", "hidden"] as const, "12"),
    expression: str(entry.get("expression")),
    relation: str(entry.get("relation")),
    twoWay: bool(entry.get("twoWay")),
    backProp: str(entry.get("backProp")),
    rollupRelation: str(entry.get("rollupRelation")),
    rollupTarget: str(entry.get("rollupTarget")),
    rollupFn: oneOf(entry.get("rollupFn"), ROLLUP_FNS, "show_original"),
    prefix: str(entry.get("prefix")),
    nextId: num(entry.get("nextId"), 1),
    description: str(entry.get("description")),
  };
}

const EMPTY_ENTRY = new Y.Doc().getMap<unknown>("empty");

export function readSchema(doc: Y.Doc): Property[] {
  const out: Property[] = [];
  schemaOf(doc).forEach((entry, id) => {
    if (entry instanceof Y.Map && entry.get("deleted") !== true) out.push(readProperty(entry, id));
  });
  if (!out.some((p) => p.id === TITLE)) out.push(readProperty(EMPTY_ENTRY, TITLE));
  return out.sort((a, b) => (a.id === TITLE ? -1 : b.id === TITLE ? 1 : byOrder(a, b)));
}

export type PropertyInput = Partial<Omit<Property, "id" | "options" | "order">> & { options?: Omit<SelectOption, "id" | "order">[] };

function defaultStatusOptions(): Omit<SelectOption, "id" | "order">[] {
  return [
    { name: "Not started", color: "default", group: "todo" },
    { name: "In progress", color: "blue", group: "doing" },
    { name: "Done", color: "green", group: "done" },
  ];
}

function writeOptions(entry: Y.Map<unknown>, options: Omit<SelectOption, "id" | "order">[]) {
  let map = entry.get("options");
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<unknown>();
    entry.set("options", map);
  }
  let last: string | null = null;
  for (const option of options) {
    const order = orderBetween(last, null);
    last = order;
    const o = new Y.Map<unknown>();
    o.set("name", option.name);
    o.set("color", option.color);
    o.set("order", order);
    if (option.group) o.set("group", option.group);
    (map as Y.Map<unknown>).set(newId(), o);
  }
}

export function addProperty(doc: Y.Doc, input: PropertyInput & { type: PropType }, options: { id?: string; after?: string | null } = {}): string {
  const id = options.id ?? newId();
  doc.transact(() => {
    const schema = readSchema(doc).filter((p) => p.id !== TITLE);
    let order: string;
    if (options.after === undefined) order = orderBetween(schema.at(-1)?.order ?? null, null);
    else {
      const index = options.after === null || options.after === TITLE ? -1 : schema.findIndex((p) => p.id === options.after);
      order = orderBetween(schema[index]?.order ?? null, schema[index + 1]?.order ?? null);
    }
    const entry = new Y.Map<unknown>();
    const { options: opts, ...rest } = input;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) entry.set(k, v);
    entry.set("name", input.name ?? typeLabel(input.type));
    entry.set("order", order);
    entry.set("options", new Y.Map<unknown>());
    schemaOf(doc).set(id, entry);
    if (input.type === "status") writeOptions(entry, opts ?? defaultStatusOptions());
    else if (opts) writeOptions(entry, opts);
  });
  return id;
}

export function propEntry(doc: Y.Doc, id: string): Y.Map<unknown> {
  let entry = schemaOf(doc).get(id);
  if (!(entry instanceof Y.Map)) {
    entry = new Y.Map<unknown>();
    if (id === TITLE) entry.set("name", "Name");
    schemaOf(doc).set(id, entry);
  }
  return entry;
}

export function updateProperty(doc: Y.Doc, id: string, patch: Partial<Omit<Property, "id" | "options">>) {
  doc.transact(() => {
    const entry = propEntry(doc, id);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && !(id === TITLE && k === "type")) entry.set(k, v);
    if (patch.type === "status" && !(entry.get("options") instanceof Y.Map && (entry.get("options") as Y.Map<unknown>).size > 0)) writeOptions(entry, defaultStatusOptions());
    if (patch.type === "status") {
      const map = entry.get("options");
      if (map instanceof Y.Map) map.forEach((o) => o instanceof Y.Map && !o.get("group") && o.set("group", "todo"));
    }
  });
}

export function renameProperty(doc: Y.Doc, id: string, name: string) {
  updateProperty(doc, id, { name: name.slice(0, 200) });
}

export function deleteProperty(doc: Y.Doc, id: string) {
  if (id === TITLE) return;
  const entry = schemaOf(doc).get(id);
  if (entry instanceof Y.Map) entry.set("deleted", true);
}

export function moveProperty(doc: Y.Doc, id: string, after: string | null) {
  if (id === TITLE) return;
  const schema = readSchema(doc).filter((p) => p.id !== TITLE && p.id !== id);
  const index = after === null || after === TITLE ? -1 : schema.findIndex((p) => p.id === after);
  updateProperty(doc, id, { order: orderBetween(schema[index]?.order ?? null, schema[index + 1]?.order ?? null) });
}

export function duplicateProperty(doc: Y.Doc, id: string): string | null {
  const prop = readSchema(doc).find((p) => p.id === id);
  if (!prop || id === TITLE) return null;
  const { id: _id, options, order: _order, ...rest } = prop;
  return addProperty(doc, { ...rest, name: `${prop.name} (copy)`, options: options.map(({ name, color, group }) => ({ name, color, ...(group ? { group } : {}) })), backProp: "", twoWay: false }, { after: id });
}

function optionsMap(doc: Y.Doc, prop: string): Y.Map<Y.Map<unknown>> {
  const entry = propEntry(doc, prop);
  let map = entry.get("options");
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<unknown>();
    entry.set("options", map);
  }
  return map as Y.Map<Y.Map<unknown>>;
}

const OPTION_COLORS: Color[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

export function addOption(doc: Y.Doc, prop: string, name: string, extra: { color?: Color; group?: StatusGroup; id?: string } = {}): string {
  const id = extra.id ?? newId();
  doc.transact(() => {
    const options = readSchema(doc).find((p) => p.id === prop)?.options ?? [];
    const inGroup = extra.group ? options.filter((o) => o.group === extra.group) : options;
    const lastOrder = inGroup.at(-1)?.order ?? null;
    const nextIndex = lastOrder === null ? -1 : options.findIndex((o) => o.order === lastOrder);
    const o = new Y.Map<unknown>();
    o.set("name", name.slice(0, 200));
    o.set("color", extra.color ?? OPTION_COLORS[options.length % OPTION_COLORS.length]!);
    o.set("order", orderBetween(lastOrder, options[nextIndex + 1]?.order ?? null));
    if (extra.group) o.set("group", extra.group);
    optionsMap(doc, prop).set(id, o);
  });
  return id;
}

export function updateOption(doc: Y.Doc, prop: string, option: string, patch: Partial<Omit<SelectOption, "id">>) {
  doc.transact(() => {
    const o = optionsMap(doc, prop).get(option);
    if (!(o instanceof Y.Map)) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) o.set(k, k === "name" ? String(v).slice(0, 200) : v);
  });
}

export function deleteOption(doc: Y.Doc, prop: string, option: string) {
  optionsMap(doc, prop).delete(option);
}

export function moveOption(doc: Y.Doc, prop: string, option: string, after: string | null, group?: StatusGroup) {
  const options = (readSchema(doc).find((p) => p.id === prop)?.options ?? []).filter((o) => o.id !== option);
  let index: number;
  if (after === null) {
    if (group) {
      const firstInGroup = options.findIndex((o) => o.group === group);
      index = firstInGroup === -1 ? (() => {
        const groups = STATUS_GROUPS.map((g) => g.id);
        const pos = groups.indexOf(group);
        let last = -1;
        options.forEach((o, i) => {
          if (o.group && groups.indexOf(o.group) < pos) last = i;
        });
        return last;
      })() : firstInGroup - 1;
    } else index = -1;
  } else index = options.findIndex((o) => o.id === after);
  updateOption(doc, prop, option, { order: orderBetween(options[index]?.order ?? null, options[index + 1]?.order ?? null), ...(group ? { group } : {}) });
}

export function findOptionByName(prop: Property, name: string): SelectOption | undefined {
  const lower = name.trim().toLowerCase();
  return prop.options.find((o) => o.name.trim().toLowerCase() === lower);
}

export type DatabaseSettings = {
  openAs: "side" | "center" | "full";
  description: string;
  locked: boolean;
  source: PageId | "";
  defaultTemplate: PageId | "";
  showDescription: boolean;
};

export function readSettings(doc: Y.Doc): DatabaseSettings {
  const s = settingsOf(doc);
  return {
    openAs: oneOf(s.get("openAs"), ["side", "center", "full"] as const, "side"),
    description: str(s.get("description")),
    locked: bool(s.get("locked")),
    source: str(s.get("source")),
    defaultTemplate: str(s.get("defaultTemplate")),
    showDescription: bool(s.get("showDescription"), true),
  };
}

export function updateSettings(doc: Y.Doc, patch: Partial<DatabaseSettings>) {
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) settingsOf(doc).set(k, v);
  });
}

export type Person = { id: string; name: string; color: string };

export function readPeople(doc: Y.Doc): Person[] {
  const out: Person[] = [];
  peopleOf(doc).forEach((v, id) => {
    if (v && typeof v === "object") out.push({ id, name: str((v as Record<string, unknown>).name, "Someone"), color: str((v as Record<string, unknown>).color, "#888") });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function rememberPerson(doc: Y.Doc, person: Person) {
  const known = peopleOf(doc).get(person.id) as Record<string, unknown> | undefined;
  if (known && known.name === person.name && known.color === person.color) return;
  peopleOf(doc).set(person.id, { name: person.name.slice(0, 100), color: person.color.slice(0, 32) });
}

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart" | "form";
export const VIEW_TYPES: { type: ViewType; label: string }[] = [
  { type: "table", label: "Table" },
  { type: "board", label: "Board" },
  { type: "list", label: "List" },
  { type: "gallery", label: "Gallery" },
  { type: "calendar", label: "Calendar" },
  { type: "timeline", label: "Timeline" },
  { type: "chart", label: "Chart" },
  { type: "form", label: "Form" },
];

export type FilterCond =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts"
  | "ends"
  | "empty"
  | "not_empty"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "between"
  | "relative"
  | "checked"
  | "unchecked";

export type RelativeRange = "today" | "tomorrow" | "yesterday" | "past_week" | "past_month" | "past_year" | "next_week" | "next_month" | "next_year" | "this_week" | "this_month" | "this_year";
export const RELATIVE_RANGES: { id: RelativeRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "yesterday", label: "Yesterday" },
  { id: "past_week", label: "Past week" },
  { id: "past_month", label: "Past month" },
  { id: "past_year", label: "Past year" },
  { id: "next_week", label: "Next week" },
  { id: "next_month", label: "Next month" },
  { id: "next_year", label: "Next year" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
  { id: "this_year", label: "This year" },
];

export type FilterRule = { kind: "rule"; id: string; prop: string; cond: FilterCond; value?: unknown };
export type FilterGroup = { kind: "group"; id: string; op: "and" | "or"; rules: (FilterRule | FilterGroup)[] };
export type SortRule = { id: string; prop: string; dir: "asc" | "desc" };
export type GroupBy = {
  prop: string;
  date: "relative" | "day" | "week" | "month" | "year";
  text: "exact" | "alpha";
  status: "option" | "group";
  step: number;
  sort: "manual" | "asc" | "desc";
  hideEmpty: boolean;
};
export type ViewProp = { visible?: boolean; width?: number; order?: string };
export type FormField = { prop: string; required: boolean; label?: string; help?: string };
export type GroupState = { hidden?: boolean; collapsed?: boolean; order?: string };

export type View = {
  id: string;
  name: string;
  type: ViewType;
  order: string;
  filter: FilterGroup;
  sorts: SortRule[];
  groupBy: GroupBy | null;
  subGroupBy: GroupBy | null;
  groups: Record<string, GroupState>;
  subGroups: Record<string, GroupState>;
  props: Record<string, ViewProp>;
  wrap: boolean;
  frozen: number;
  calcs: Record<string, CalcFn>;
  cardPreview: "none" | "cover" | "content" | string;
  cardSize: "small" | "medium" | "large";
  fitImage: boolean;
  colorColumns: boolean;
  dateProp: string;
  endProp: string;
  zoom: "day" | "week" | "month" | "quarter" | "year";
  showTable: boolean;
  showWeekends: boolean;
  limit: number;
  chartType: "bar" | "line" | "donut";
  chartBy: string;
  chartAgg: "count" | "sum" | "avg";
  chartValue: string;
  showIcons: boolean;
  lineNumbers: boolean;
  icon: string;
  formFields: FormField[];
  formTitle: string;
  formDescription: string;
  filterBar: boolean;
};

export const emptyFilter = (): FilterGroup => ({ kind: "group", id: "root", op: "and", rules: [] });

const MAX_FILTER_NODES = 200;

export function cleanFilter(raw: unknown, depth = 0, budget = { n: 0 }): FilterGroup {
  const group = emptyFilter();
  if (!raw || typeof raw !== "object") return group;
  const r = raw as Record<string, unknown>;
  group.id = typeof r.id === "string" ? r.id.slice(0, 40) : "root";
  group.op = r.op === "or" ? "or" : "and";
  if (!Array.isArray(r.rules) || depth > 3) return group;
  for (const item of r.rules) {
    if (budget.n++ > MAX_FILTER_NODES) break;
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.kind === "group") group.rules.push(cleanFilter(it, depth + 1, budget));
    else if (typeof it.prop === "string" && typeof it.cond === "string")
      group.rules.push({ kind: "rule", id: typeof it.id === "string" ? it.id.slice(0, 40) : newId(), prop: it.prop, cond: it.cond as FilterCond, ...(it.value !== undefined ? { value: it.value } : {}) });
  }
  return group;
}

function cleanGroupBy(raw: unknown): GroupBy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.prop !== "string" || !r.prop) return null;
  return {
    prop: r.prop,
    date: oneOf(r.date, ["relative", "day", "week", "month", "year"] as const, "relative"),
    text: oneOf(r.text, ["exact", "alpha"] as const, "exact"),
    status: oneOf(r.status, ["option", "group"] as const, "option"),
    step: num(r.step, 10) > 0 ? num(r.step, 10) : 10,
    sort: oneOf(r.sort, ["manual", "asc", "desc"] as const, "manual"),
    hideEmpty: bool(r.hideEmpty),
  };
}

const FIELD_SEP = "\u0001";

function readNestedRecord<T>(value: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  if (value instanceof Y.Map) value.forEach((v, k) => (out[k] = (v instanceof Y.Map ? v.toJSON() : v) as T));
  return out;
}

function readFieldRecord<T extends object>(value: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  if (!(value instanceof Y.Map)) return out;
  value.forEach((v, k) => {
    const at = k.lastIndexOf(FIELD_SEP);
    if (at >= 0) {
      const key = k.slice(0, at);
      const target = (out[key] ??= {} as T) as Record<string, unknown>;
      target[k.slice(at + 1)] = v;
    } else if (v instanceof Y.Map || (v && typeof v === "object")) {
      const json = (v instanceof Y.Map ? v.toJSON() : v) as Record<string, unknown>;
      out[k] = { ...json, ...(out[k] ?? {}) } as T;
    }
  });
  return out;
}

const CALC_FNS: CalcFn[] = ["none", ...ROLLUP_FNS.filter((f): f is Exclude<RollupFn, "show_original"> => f !== "show_original")];
const VIEW_TYPE_IDS = VIEW_TYPES.map((v) => v.type);

export function readView(entry: Y.Map<unknown>): View {
  const type = oneOf(entry.get("type"), VIEW_TYPE_IDS, "table");
  const calcsRaw = readNestedRecord<unknown>(entry.get("calcs"));
  const calcs: Record<string, CalcFn> = Object.create(null);
  for (const [k, v] of Object.entries(calcsRaw)) calcs[k] = oneOf(v, CALC_FNS, "none");
  const sortsRaw = entry.get("sorts");
  return {
    id: str(entry.get("id")),
    name: str(entry.get("name"), VIEW_TYPES.find((v) => v.type === type)!.label),
    type,
    order: str(entry.get("order")),
    filter: cleanFilter(entry.get("filter")),
    sorts: Array.isArray(sortsRaw)
      ? sortsRaw
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as Record<string, unknown>).prop === "string")
          .slice(0, 20)
          .map((s) => ({ id: str(s.id, newId()), prop: s.prop as string, dir: s.dir === "desc" ? "desc" : "asc" }))
      : [],
    groupBy: cleanGroupBy(entry.get("groupBy")),
    subGroupBy: cleanGroupBy(entry.get("subGroupBy")),
    groups: readFieldRecord<GroupState>(entry.get("groups")),
    subGroups: readFieldRecord<GroupState>(entry.get("subGroups")),
    props: readFieldRecord<ViewProp>(entry.get("props")),
    wrap: bool(entry.get("wrap")),
    frozen: num(entry.get("frozen"), 1),
    calcs,
    cardPreview: str(entry.get("cardPreview"), type === "gallery" ? "content" : "none"),
    cardSize: oneOf(entry.get("cardSize"), ["small", "medium", "large"] as const, "medium"),
    fitImage: bool(entry.get("fitImage")),
    colorColumns: bool(entry.get("colorColumns"), true),
    dateProp: str(entry.get("dateProp")),
    endProp: str(entry.get("endProp")),
    zoom: oneOf(entry.get("zoom"), ["day", "week", "month", "quarter", "year"] as const, "month"),
    showTable: bool(entry.get("showTable"), true),
    showWeekends: bool(entry.get("showWeekends"), true),
    limit: num(entry.get("limit"), type === "board" || type === "gallery" ? 25 : 50),
    chartType: oneOf(entry.get("chartType"), ["bar", "line", "donut"] as const, "bar"),
    chartBy: str(entry.get("chartBy")),
    chartAgg: oneOf(entry.get("chartAgg"), ["count", "sum", "avg"] as const, "count"),
    chartValue: str(entry.get("chartValue")),
    showIcons: bool(entry.get("showIcons"), true),
    lineNumbers: bool(entry.get("lineNumbers")),
    icon: str(entry.get("icon")).slice(0, 2000),
    formFields: cleanFormFields(entry.get("formFields")),
    formTitle: str(entry.get("formTitle")).slice(0, 500),
    formDescription: str(entry.get("formDescription")).slice(0, 5000),
    filterBar: bool(entry.get("filterBar")),
  };
}

export function cleanFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.prop !== "string" || !r.prop || seen.has(r.prop)) continue;
    seen.add(r.prop);
    out.push({ prop: r.prop, required: r.required === true, ...(typeof r.label === "string" && r.label ? { label: r.label.slice(0, 500) } : {}), ...(typeof r.help === "string" && r.help ? { help: r.help.slice(0, 2000) } : {}) });
  }
  return out;
}

export function formFieldsFor(view: View, schema: Property[]): FormField[] {
  const known = new Set(schema.map((p) => p.id));
  const listed = view.formFields.filter((f) => known.has(f.prop));
  if (listed.length) return listed;
  return schema.filter((p) => isEditable(p.type)).map((p) => ({ prop: p.id, required: p.id === TITLE }));
}

export function readViews(doc: Y.Doc): View[] {
  const seen = new Set<string>();
  const out: View[] = [];
  viewMapOf(doc).forEach((entry, id) => {
    if (!(entry instanceof Y.Map) || entry.get("id") !== id) return;
    seen.add(id);
    out.push(readView(entry));
  });
  viewsOf(doc).forEach((entry) => {
    if (!(entry instanceof Y.Map)) return;
    const view = readView(entry);
    if (!view.id || seen.has(view.id)) return;
    seen.add(view.id);
    out.push(view);
  });
  return out.sort(byOrder);
}

function viewEntry(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const keyed = viewMapOf(doc).get(id);
  if (keyed instanceof Y.Map && keyed.get("id") === id) return keyed;
  let found: Y.Map<unknown> | null = null;
  viewsOf(doc).forEach((entry) => {
    if (!found && entry instanceof Y.Map && entry.get("id") === id) found = entry;
  });
  return found;
}

function firstPropOfTypes(schema: Property[], types: PropType[]) {
  return schema.find((p) => types.includes(p.type))?.id ?? "";
}

export function defaultsForView(type: ViewType, schema: Property[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (type === "board") {
    const prop = firstPropOfTypes(schema, ["status"]) || firstPropOfTypes(schema, ["select"]) || firstPropOfTypes(schema, ["person", "checkbox", "multi_select"]);
    if (prop) out.groupBy = { prop };
  }
  if (type === "calendar" || type === "timeline") out.dateProp = firstPropOfTypes(schema, ["date"]) || firstPropOfTypes(schema, ["created_time"]);
  if (type === "chart") out.chartBy = firstPropOfTypes(schema, ["status", "select", "multi_select", "person", "checkbox"]);
  return out;
}

export function addView(doc: Y.Doc, type: ViewType, options: { id?: string; name?: string; after?: string; init?: Record<string, unknown> } = {}): string {
  const id = options.id ?? newId();
  doc.transact(() => {
    const views = readViews(doc);
    const index = options.after ? views.findIndex((v) => v.id === options.after) : views.length - 1;
    const entry = new Y.Map<unknown>();
    entry.set("id", id);
    entry.set("type", type);
    entry.set("name", options.name ?? VIEW_TYPES.find((v) => v.type === type)!.label);
    entry.set("order", orderBetween(views[index]?.order ?? null, views[index + 1]?.order ?? null));
    entry.set("props", new Y.Map());
    entry.set("calcs", new Y.Map());
    entry.set("groups", new Y.Map());
    entry.set("subGroups", new Y.Map());
    for (const [k, v] of Object.entries({ ...defaultsForView(type, readSchema(doc)), ...(options.init ?? {}) })) entry.set(k, v);
    viewMapOf(doc).set(id, entry);
  });
  return id;
}

export function updateView(doc: Y.Doc, id: string, patch: Partial<Omit<View, "id" | "props" | "calcs" | "groups" | "subGroups">>) {
  doc.transact(() => {
    const entry = viewEntry(doc, id);
    if (!entry) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === "name") entry.set(k, String(v).slice(0, 200));
      else entry.set(k, v === null ? null : JSON.parse(JSON.stringify(v)));
    }
  });
}

function nested(entry: Y.Map<unknown>, key: string): Y.Map<unknown> {
  let map = entry.get(key);
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<unknown>();
    entry.set(key, map);
  }
  return map as Y.Map<unknown>;
}

export function setViewProp(doc: Y.Doc, view: string, prop: string, patch: ViewProp) {
  doc.transact(() => {
    const entry = viewEntry(doc, view);
    if (!entry) return;
    const props = nested(entry, "props");
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) props.set(`${prop}${FIELD_SEP}${k}`, v);
  });
}

export function setGroupState(doc: Y.Doc, view: string, key: string, patch: GroupState, sub = false) {
  doc.transact(() => {
    const entry = viewEntry(doc, view);
    if (!entry) return;
    const groups = nested(entry, sub ? "subGroups" : "groups");
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) groups.set(`${key}${FIELD_SEP}${k}`, v);
  });
}

export function setCalc(doc: Y.Doc, view: string, prop: string, fn: CalcFn) {
  doc.transact(() => {
    const entry = viewEntry(doc, view);
    if (!entry) return;
    const calcs = nested(entry, "calcs");
    if (fn === "none") calcs.delete(prop);
    else calcs.set(prop, fn);
  });
}

export function renameView(doc: Y.Doc, id: string, name: string) {
  updateView(doc, id, { name });
}

export function deleteView(doc: Y.Doc, id: string) {
  doc.transact(() => {
    viewMapOf(doc).delete(id);
    const array = viewsOf(doc);
    for (let i = array.length - 1; i >= 0; i--) {
      const entry = array.get(i);
      if (entry instanceof Y.Map && entry.get("id") === id) array.delete(i, 1);
    }
  });
}

export function moveView(doc: Y.Doc, id: string, after: string | null) {
  const views = readViews(doc).filter((v) => v.id !== id);
  const index = after === null ? -1 : views.findIndex((v) => v.id === after);
  updateView(doc, id, { order: orderBetween(views[index]?.order ?? null, views[index + 1]?.order ?? null) });
}

export function duplicateView(doc: Y.Doc, id: string): string | null {
  const entry = viewEntry(doc, id);
  if (!entry) return null;
  const json = entry.toJSON() as Record<string, unknown>;
  const fresh = newId();
  const { id: _id, order: _order, props: _props, calcs: _calcs, groups: _groups, subGroups: _subGroups, name, type: _type, ...rest } = json;
  const view = readView(entry);
  addView(doc, view.type, { id: fresh, name: `${String(name ?? view.name)} (copy)`, after: id, init: rest });
  doc.transact(() => {
    for (const [k, v] of Object.entries(view.props)) setViewProp(doc, fresh, k, v);
    for (const [k, v] of Object.entries(view.calcs)) setCalc(doc, fresh, k, v);
    for (const [k, v] of Object.entries(view.groups)) setGroupState(doc, fresh, k, v);
    for (const [k, v] of Object.entries(view.subGroups)) setGroupState(doc, fresh, k, v, true);
  });
  return fresh;
}

export const DEFAULT_VIEW = "default";
export const DEFAULT_TAGS = "tags";

export function isInitialized(doc: Y.Doc) {
  return settingsOf(doc).get("initialized") === true || viewsOf(doc).length > 0 || viewMapOf(doc).size > 0;
}

export function initDatabase(doc: Y.Doc, options: { view?: ViewType; title?: string } = {}) {
  if (isInitialized(doc)) return;
  doc.transact(() => {
    settingsOf(doc).set("initialized", true);
    propEntry(doc, TITLE);
    if (!schemaOf(doc).has(DEFAULT_TAGS)) addProperty(doc, { type: "multi_select", name: "Tags" }, { id: DEFAULT_TAGS });
    addView(doc, options.view ?? "table", { id: DEFAULT_VIEW, name: options.title ?? VIEW_TYPES.find((v) => v.type === (options.view ?? "table"))!.label });
  });
}

export function initLinkedDatabase(doc: Y.Doc, source: PageId, view: ViewType = "table", sourceSchema: Property[] = []) {
  if (isInitialized(doc)) return;
  doc.transact(() => {
    settingsOf(doc).set("initialized", true);
    settingsOf(doc).set("source", source);
    addView(doc, view, { id: DEFAULT_VIEW, init: defaultsForView(view, sourceSchema) });
  });
}

export function isVisible(view: View, prop: Property): boolean {
  if (prop.id === TITLE) return view.props[TITLE]?.visible !== false || view.type === "table" || view.type === "list" || view.type === "timeline";
  const explicit = view.props[prop.id]?.visible;
  if (explicit !== undefined) return explicit;
  return view.type === "table";
}

export function viewProperties(view: View, schema: Property[]): Property[] {
  const titleFirst = view.type !== "board" && view.type !== "gallery";
  const indexed = schema.map((p, i) => ({ p, key: view.props[p.id]?.order || "~", i }));
  return indexed
    .sort((a, b) => {
      if (titleFirst && a.p.id === TITLE) return -1;
      if (titleFirst && b.p.id === TITLE) return 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i;
    })
    .map((x) => x.p);
}

export function moveViewProp(doc: Y.Doc, view: View, schema: Property[], prop: string, after: string | null) {
  const ordered = viewProperties(view, schema).filter((p) => p.id !== prop);
  doc.transact(() => {
    let prev: string | null = null;
    const keys = new Map<string, string>();
    for (const p of ordered) {
      prev = orderBetween(prev, null);
      keys.set(p.id, prev);
    }
    const index = after === null ? -1 : ordered.findIndex((p) => p.id === after);
    const before = index >= 0 ? keys.get(ordered[index]!.id)! : null;
    const next = ordered[index + 1] ? keys.get(ordered[index + 1]!.id)! : null;
    for (const [id, key] of keys) if (view.props[id]?.order !== key) setViewProp(doc, view.id, id, { order: key });
    setViewProp(doc, view.id, prop, { order: orderBetween(before, next) });
  });
}

export type DateValue = { start: string; end?: string };
export type FileValue = { ref: string; name: string; type: string };

export type FDate = { t: "date"; start: number; end?: number; time: boolean };
export type FPage = { t: "page"; id: string; title: string };
export type FPerson = { t: "person"; id: string; name: string };
export type FValue = null | number | string | boolean | FDate | FPage | FPerson | FValue[];
export type FError = { error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export function parseDateString(value: unknown): { ms: number; time: boolean } | null {
  if (typeof value !== "string") return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0];
  const date = new Date(y, mo, d, h, mi);
  const ms = date.getTime();
  if (!Number.isFinite(ms) || date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d || h > 23 || mi > 59) return null;
  return { ms, time: m[4] !== undefined };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toDateString(ms: number, time = false): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

export function cleanDate(value: unknown): DateValue | null {
  if (typeof value === "string") return parseDateString(value) ? { start: value } : null;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!parseDateString(v.start)) return null;
  return parseDateString(v.end) ? { start: v.start as string, end: v.end as string } : { start: v.start as string };
}

export function dateToF(value: DateValue | null): FDate | null {
  if (!value) return null;
  const s = parseDateString(value.start);
  if (!s) return null;
  const e = parseDateString(value.end);
  return { t: "date", start: s.ms, ...(e ? { end: e.ms } : {}), time: s.time };
}

export const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
export const addDays = (ms: number, n: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()).getTime();
};
export const addMonths = (ms: number, n: number) => {
  const d = new Date(ms);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target.getTime();
};
export const startOfWeek = (ms: number) => addDays(startOfDay(ms), -new Date(ms).getDay());
export const daysBetween = (a: number, b: number) => Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export function formatTime(ms: number, format: "12" | "24" | "hidden" = "12"): string {
  if (format === "hidden") return "";
  const d = new Date(ms);
  if (format === "24") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

export function formatDay(ms: number, format: DateFormat = "full", now = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  switch (format) {
    case "short":
    case "mdy":
      return `${m}/${day}/${y}`;
    case "dmy":
      return `${day}/${m}/${y}`;
    case "ymd":
      return `${y}/${m}/${day}`;
    case "relative": {
      const diff = daysBetween(now, ms);
      if (diff === 0) return "Today";
      if (diff === 1) return "Tomorrow";
      if (diff === -1) return "Yesterday";
      if (diff > 1 && diff < 7) return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]}`;
      if (diff < 0 && diff > -7) return `Last ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]}`;
      return new Date(now).getFullYear() === y ? `${MONTHS_SHORT[d.getMonth()]} ${day}` : `${MONTHS_SHORT[d.getMonth()]} ${day}, ${y}`;
    }
    default:
      return `${MONTHS[d.getMonth()]} ${day}, ${y}`;
  }
}

export function formatDate(value: FDate | null, prop?: Pick<Property, "dateFormat" | "timeFormat">, now = Date.now()): string {
  if (!value) return "";
  const fmt = prop?.dateFormat ?? "full";
  const tf = prop?.timeFormat ?? "12";
  const one = (ms: number) => (value.time && tf !== "hidden" ? `${formatDay(ms, fmt, now)} ${formatTime(ms, tf)}` : formatDay(ms, fmt, now));
  return value.end !== undefined ? `${one(value.start)} → ${one(value.end)}` : one(value.start);
}

export function formatNumber(value: number | null, format: NumberFormat = "number"): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (format === "number") return String(Math.round(value * 1e10) / 1e10);
  if (format === "commas") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(value);
  if (format === "percent") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value * 100)}%`;
  const currency = CURRENCY[format];
  if (!currency) return String(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2 }).format(value);
}

export type DbContext = {
  database: PageId;
  schema: Property[];
  rows: PageMeta[];
  page: (id: string) => PageMeta | null;
  schemaFor: (database: string) => Property[] | null;
  rowsFor: (database: string) => PageMeta[];
  people: Map<string, Person>;
  now: number;
  cache: Map<string, FValue | FError>;
  stack: Set<string>;
};

export function makeContext(input: Omit<DbContext, "cache" | "stack" | "now" | "rowsFor"> & { now?: number; rowsFor?: (database: string) => PageMeta[] }): DbContext {
  return { ...input, rowsFor: input.rowsFor ?? (() => []), now: input.now ?? Date.now(), cache: new Map(), stack: new Set() };
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);

export function cleanFiles(v: unknown): FileValue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as Record<string, unknown>).ref === "string")
    .map((f) => ({ ref: f.ref as string, name: str(f.name, "file"), type: str(f.type) }));
}

export function rawValue(row: PageMeta, prop: Property): unknown {
  switch (prop.type) {
    case "title":
      return row.title;
    case "created_time":
      return { start: toDateString(row.createdAt, true) };
    case "edited_time":
      return { start: toDateString(row.updatedAt, true) };
    case "created_by":
      return row.createdBy ? [row.createdBy] : [];
    case "edited_by":
      return row.updatedBy ? [row.updatedBy] : [];
    default:
      return row.props[prop.id];
  }
}

export function textValue(row: PageMeta, prop: Property): string {
  const v = rawValue(row, prop);
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
export const numberValue = (row: PageMeta, prop: Property): number | null => {
  const v = row.props[prop.id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
export const idsValue = (row: PageMeta, prop: Property): string[] => asStrings(rawValue(row, prop));
export const dateValue = (row: PageMeta, prop: Property): DateValue | null => cleanDate(rawValue(row, prop));
export const checkValue = (row: PageMeta, prop: Property): boolean => row.props[prop.id] === true;
export const filesValue = (row: PageMeta, prop: Property): FileValue[] => cleanFiles(row.props[prop.id]);

export function optionOf(prop: Property, id: string | undefined | null): SelectOption | undefined {
  return id ? prop.options.find((o) => o.id === id) : undefined;
}

export function selectValue(row: PageMeta, prop: Property): SelectOption | undefined {
  const v = row.props[prop.id];
  return typeof v === "string" ? optionOf(prop, v) : undefined;
}

export function multiValue(row: PageMeta, prop: Property): SelectOption[] {
  return asStrings(row.props[prop.id])
    .map((id) => optionOf(prop, id))
    .filter((o): o is SelectOption => !!o);
}

export function personName(ctx: Pick<DbContext, "people">, id: string) {
  return ctx.people.get(id)?.name ?? "Someone";
}

export function fvalue(ctx: DbContext, row: PageMeta, prop: Property): FValue | FError {
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return textValue(row, prop);
    case "number":
    case "id":
      return numberValue(row, prop);
    case "select":
    case "status":
      return selectValue(row, prop)?.name ?? null;
    case "multi_select":
      return multiValue(row, prop).map((o) => o.name);
    case "date":
    case "created_time":
    case "edited_time":
      return dateToF(dateValue(row, prop));
    case "person":
    case "edited_by":
      return idsValue(row, prop).map((id): FPerson => ({ t: "person", id, name: personName(ctx, id) }));
    case "created_by": {
      const id = idsValue(row, prop)[0];
      return id ? { t: "person", id, name: personName(ctx, id) } : null;
    }
    case "files":
      return filesValue(row, prop).map((f) => f.name);
    case "checkbox":
      return checkValue(row, prop);
    case "relation":
      return idsValue(row, prop)
        .map((id) => ctx.page(id))
        .filter((p): p is PageMeta => !!p && !p.deleted && !p.archivedAt)
        .map((p): FPage => ({ t: "page", id: p.id, title: p.title || "Untitled" }));
    case "formula":
      return formulaValue(ctx, row, prop);
    case "rollup":
      return rollupValue(ctx, row, prop);
  }
}

export const isError = (v: unknown): v is FError => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as FError).error === "string";

export function isEmptyF(v: FValue | FError): boolean {
  if (v === null || v === "" || isError(v)) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isEmptyF(x));
  return false;
}

export function fToText(v: FValue | FError, prop?: Pick<Property, "dateFormat" | "timeFormat" | "format">, now?: number): string {
  if (isError(v)) return "";
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return prop?.format ? formatNumber(v, prop.format) : formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => fToText(x, prop, now)).filter(Boolean).join(", ");
  if (v.t === "date") return formatDate(v, prop as Property, now);
  if (v.t === "page") return v.title;
  return v.name;
}

export type Kind = "text" | "number" | "select" | "multi" | "date" | "checkbox" | "person" | "files" | "relation";

export function fKind(v: FValue | FError): Kind | null {
  if (v === null || isError(v)) return null;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  if (typeof v === "string") return "text";
  if (Array.isArray(v)) {
    const first = v.find((x) => x !== null);
    if (first === undefined) return null;
    const k = fKind(first);
    return k === "number" || k === "date" || k === "checkbox" ? k : k === "person" ? "person" : k === "relation" ? "relation" : "multi";
  }
  if (v.t === "date") return "date";
  if (v.t === "page") return "relation";
  return "person";
}

export function kindOf(ctx: DbContext, prop: Property): Kind {
  switch (prop.type) {
    case "number":
    case "id":
      return "number";
    case "select":
    case "status":
      return "select";
    case "multi_select":
      return "multi";
    case "date":
    case "created_time":
    case "edited_time":
      return "date";
    case "checkbox":
      return "checkbox";
    case "person":
    case "created_by":
    case "edited_by":
      return "person";
    case "files":
      return "files";
    case "relation":
      return "relation";
    case "formula":
    case "rollup": {
      const key = `kind:${prop.id}`;
      const cached = ctx.cache.get(key);
      if (typeof cached === "string") return cached as Kind;
      let kind: Kind = prop.type === "rollup" && prop.rollupFn !== "show_original" ? "number" : "text";
      for (const row of ctx.rows.slice(0, 50)) {
        const k = fKind(fvalue(ctx, row, prop));
        if (k) {
          kind = k;
          break;
        }
      }
      ctx.cache.set(key, kind);
      return kind;
    }
    default:
      return "text";
  }
}

export const FORMULA_MAX_LENGTH = 4000;
const MAX_DEPTH = 60;
const MAX_STEPS = 20_000;
const MAX_STRING = 20_000;
const MAX_LIST = 2_000;

type Token = { k: "num"; v: number; at: number } | { k: "str"; v: string; at: number } | { k: "id"; v: string; at: number } | { k: "op"; v: string; at: number } | { k: "end"; at: number };

export type Ast =
  | { k: "lit"; v: FValue }
  | { k: "list"; items: Ast[] }
  | { k: "name"; v: string }
  | { k: "call"; fn: string; args: Ast[] }
  | { k: "un"; op: string; a: Ast }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "cond"; c: Ast; a: Ast; b: Ast };

class FormulaError extends Error {}

const OPS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", "^", ">", "<", "!", "(", ")", ",", "[", "]", "?", ":", "."];

function tokenize(src: string): Token[] {
  if (src.length > FORMULA_MAX_LENGTH) throw new FormulaError("Formula is too long");
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError("Missing closing quote");
      out.push({ k: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${ch}"`);
    out.push({ k: "op", v: op, at: i });
    i += op.length;
  }
  out.push({ k: "end", at: src.length });
  return out;
}

const BINARY: Record<string, number> = { "||": 1, or: 1, "&&": 2, and: 2, "==": 3, "!=": 3, ">": 4, "<": 4, ">=": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "^": 8 };

export function parseFormula(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.k === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`);
    pos++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new FormulaError("Formula is nested too deeply");
  };
  const args = (): Ast[] => {
    const list: Ast[] = [];
    expect("(");
    if (!isOp(")")) {
      do list.push(expr(0));
      while (isOp(",") && next());
    }
    expect(")");
    return list;
  };
  const primary = (): Ast => {
    enter();
    try {
      const t = next();
      if (t.k === "num") return { k: "lit", v: t.v };
      if (t.k === "str") return { k: "lit", v: t.v };
      if (t.k === "op" && t.v === "(") {
        const e = expr(0);
        expect(")");
        return e;
      }
      if (t.k === "op" && t.v === "[") {
        const items: Ast[] = [];
        if (!isOp("]")) {
          do items.push(expr(0));
          while (isOp(",") && next());
        }
        expect("]");
        return { k: "list", items };
      }
      if (t.k === "op" && (t.v === "-" || t.v === "!" || t.v === "+")) return { k: "un", op: t.v, a: unaryOperand() };
      if (t.k === "id") {
        if (t.v === "not" && !isOp("(")) return { k: "un", op: "!", a: unaryOperand() };
        if (t.v === "true") return { k: "lit", v: true };
        if (t.v === "false") return { k: "lit", v: false };
        if (isOp("(")) return { k: "call", fn: t.v, args: args() };
        return { k: "name", v: t.v };
      }
      throw new FormulaError(t.k === "end" ? "Formula ends too early" : "Unexpected symbol");
    } finally {
      depth--;
    }
  };
  const unaryOperand = (): Ast => postfix(primary());
  const postfix = (base: Ast): Ast => {
    let node = base;
    while (isOp(".")) {
      pos++;
      const name = next();
      if (name.k !== "id") throw new FormulaError("Expected a function name after \".\"");
      const rest = isOp("(") ? args() : [];
      node = { k: "call", fn: name.v, args: [node, ...rest] };
    }
    return node;
  };
  const expr = (min: number): Ast => {
    enter();
    try {
      let left = postfix(primary());
      for (;;) {
        const t = peek();
        if (t.k === "op" && t.v === "?" && min === 0) {
          pos++;
          const a = expr(0);
          expect(":");
          const b = expr(0);
          left = { k: "cond", c: left, a, b };
          continue;
        }
        const op = t.k === "op" || (t.k === "id" && (t.v === "and" || t.v === "or")) ? (t as { v: string }).v : null;
        const prec = op ? BINARY[op] : undefined;
        if (!op || prec === undefined || prec < min) break;
        pos++;
        const right = expr(op === "^" ? prec : prec + 1);
        left = { k: "bin", op: op === "and" ? "&&" : op === "or" ? "||" : op, a: left, b: right };
      }
      return left;
    } finally {
      depth--;
    }
  };
  const ast = expr(0);
  if (peek().k !== "end") throw new FormulaError("Unexpected text after the formula");
  return ast;
}

const astCache = new Map<string, Ast | FError>();

export function compileFormula(src: string): Ast | FError {
  const hit = astCache.get(src);
  if (hit) return hit;
  let out: Ast | FError;
  try {
    out = parseFormula(src);
  } catch (e) {
    out = { error: e instanceof FormulaError ? e.message : "Invalid formula" };
  }
  if (astCache.size > 500) astCache.clear();
  astCache.set(src, out);
  return out;
}

type Env = { ctx: DbContext; row: PageMeta; steps: { n: number }; vars: Map<string, FValue> };

const isDate = (v: FValue): v is FDate => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "date";
const arith = (v: FValue): number => (v === null ? 0 : toNum(v));
const toNum = (v: FValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return v.trim() && Number.isFinite(n) ? n : NaN;
  }
  if (isDate(v)) return v.start;
  return NaN;
};
const toStr = (v: FValue): string => {
  const s = fToText(v);
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
};
const truthy = (v: FValue): boolean => {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};
const cap = (s: string) => {
  if (s.length > MAX_STRING) throw new FormulaError("Text is too long");
  return s;
};
const capList = (l: FValue[]) => {
  if (l.length > MAX_LIST) throw new FormulaError("List is too long");
  return l;
};
const checkNum = (n: number): FValue => (Number.isFinite(n) ? n : null);

function equal(a: FValue, b: FValue): boolean {
  if (isDate(a) && isDate(b)) return a.start === b.start && a.end === b.end;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]!));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) return (a as FPage).id === (b as FPage).id;
  if (typeof a === "number" || typeof b === "number") {
    if (typeof a === "number" && typeof b === "number") return a === b;
    return false;
  }
  return a === b;
}

function compare(a: FValue, b: FValue): number {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const x = toNum(a);
  const y = toNum(b);
  if (Number.isNaN(x) || Number.isNaN(y)) throw new FormulaError("Can't compare these values");
  return x - y;
}

const UNITS = ["years", "quarters", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const;
type Unit = (typeof UNITS)[number];
function unitOf(v: FValue): Unit {
  const s = toStr(v).toLowerCase();
  const found = UNITS.find((u) => u === s || u.slice(0, -1) === s);
  if (!found) throw new FormulaError(`Unknown unit "${s.slice(0, 20)}"`);
  return found;
}

function shift(ms: number, n: number, unit: Unit): number {
  if (!Number.isFinite(n) || Math.abs(n) > 1e6) throw new FormulaError("Number is out of range");
  switch (unit) {
    case "years":
      return addMonths(ms, n * 12);
    case "quarters":
      return addMonths(ms, n * 3);
    case "months":
      return addMonths(ms, n);
    case "weeks":
      return addDays(ms, n * 7);
    case "days":
      return addDays(ms, n);
    case "hours":
      return ms + n * 3_600_000;
    case "minutes":
      return ms + n * 60_000;
    case "seconds":
      return ms + n * 1000;
    default:
      return ms + n;
  }
}

function between(a: number, b: number, unit: Unit): number {
  const da = new Date(a);
  const db = new Date(b);
  const months = (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth()) - (da.getDate() < db.getDate() && a > b ? 1 : da.getDate() > db.getDate() && a < b ? -1 : 0);
  switch (unit) {
    case "years":
      return Math.trunc(months / 12);
    case "quarters":
      return Math.trunc(months / 3);
    case "months":
      return months;
    case "weeks":
      return Math.trunc((a - b) / 604_800_000);
    case "days":
      return Math.trunc((a - b) / 86_400_000);
    case "hours":
      return Math.trunc((a - b) / 3_600_000);
    case "minutes":
      return Math.trunc((a - b) / 60_000);
    case "seconds":
      return Math.trunc((a - b) / 1000);
    default:
      return a - b;
  }
}

function formatDateWith(ms: number, pattern: string): string {
  const d = new Date(ms);
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()]!,
    MMM: MONTHS_SHORT[d.getMonth()]!,
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    dddd: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]!,
    ddd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]!,
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(d.getHours() % 12 || 12),
    h: String(d.getHours() % 12 || 12),
    mm: pad(d.getMinutes()),
    A: d.getHours() < 12 ? "AM" : "PM",
    a: d.getHours() < 12 ? "am" : "pm",
  };
  return pattern.slice(0, 200).replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|A|a/g, (t) => tokens[t] ?? t);
}

const asDate = (v: FValue): FDate => {
  if (isDate(v)) return v;
  if (typeof v === "number" && Number.isFinite(v)) return { t: "date", start: v, time: true };
  throw new FormulaError("Expected a date");
};
const asList = (v: FValue): FValue[] => (Array.isArray(v) ? v : v === null ? [] : [v]);

type Fn = (env: Env, args: Ast[]) => FValue;
const strict = (min: number, max: number, body: (args: FValue[], env: Env) => FValue): Fn => (env, args) => {
  if (args.length < min || args.length > max) throw new FormulaError(`Expected ${min === max ? min : `${min} to ${max}`} arguments`);
  return body(args.map((a) => run(env, a)), env);
};
const numeric = (f: (...n: number[]) => number, min = 1, max = 1): Fn => strict(min, max, (a) => checkNum(f(...a.map(toNum))));

function lambda(env: Env, listAst: Ast, body: Ast | undefined, each: (value: FValue, result: FValue, index: number) => boolean | void) {
  if (!body) throw new FormulaError("Expected 2 arguments");
  const list = asList(run(env, listAst));
  const prevCurrent = env.vars.get("current");
  const prevIndex = env.vars.get("index");
  try {
    for (let i = 0; i < list.length; i++) {
      env.vars.set("current", list[i]!);
      env.vars.set("index", i);
      if (each(list[i]!, run(env, body), i) === false) break;
    }
  } finally {
    if (prevCurrent === undefined) env.vars.delete("current");
    else env.vars.set("current", prevCurrent);
    if (prevIndex === undefined) env.vars.delete("index");
    else env.vars.set("index", prevIndex);
  }
}

const FUNCTIONS: Record<string, Fn> = {
  prop: strict(1, 1, ([name], env) => {
    const key = toStr(name!);
    const prop = env.ctx.schema.find((p) => p.name === key) ?? env.ctx.schema.find((p) => p.id === key);
    if (!prop) throw new FormulaError(`No property named "${key.slice(0, 40)}"`);
    const v = fvalue(env.ctx, env.row, prop);
    if (isError(v)) throw new FormulaError(v.error);
    return v;
  }),
  if: (env, args) => {
    if (args.length !== 3) throw new FormulaError("if() takes 3 arguments");
    return truthy(run(env, args[0]!)) ? run(env, args[1]!) : run(env, args[2]!);
  },
  ifs: (env, args) => {
    for (let i = 0; i + 1 < args.length; i += 2) if (truthy(run(env, args[i]!))) return run(env, args[i + 1]!);
    return args.length % 2 === 1 ? run(env, args[args.length - 1]!) : null;
  },
  and: (env, args) => args.every((a) => truthy(run(env, a))),
  or: (env, args) => args.some((a) => truthy(run(env, a))),
  not: strict(1, 1, ([a]) => !truthy(a!)),
  empty: strict(1, 1, ([a]) => isEmptyF(a!) || a === 0 || a === false),
  length: strict(1, 1, ([a]) => (Array.isArray(a) ? a.length : toStr(a!).length)),
  concat: strict(0, 50, (a) => (a.every((x) => Array.isArray(x)) && a.length > 0 ? capList(a.flatMap((x) => x as FValue[])) : cap(a.map(toStr).join("")))),
  join: strict(1, 2, ([list, sep]) => cap(asList(list!).map(toStr).join(sep === undefined ? "" : toStr(sep)))),
  format: strict(1, 1, ([a]) => toStr(a!)),
  toNumber: strict(1, 1, ([a]) => checkNum(toNum(a!))),
  contains: strict(2, 2, ([a, b]) => (Array.isArray(a) ? a.some((x) => equal(x, b!) || toStr(x) === toStr(b!)) : toStr(a!).includes(toStr(b!)))),
  includes: strict(2, 2, ([a, b]) => (Array.isArray(a) ? a.some((x) => equal(x, b!) || toStr(x) === toStr(b!)) : toStr(a!).includes(toStr(b!)))),
  startsWith: strict(2, 2, ([a, b]) => toStr(a!).startsWith(toStr(b!))),
  endsWith: strict(2, 2, ([a, b]) => toStr(a!).endsWith(toStr(b!))),
  test: strict(2, 2, ([a, b]) => toStr(a!).toLowerCase().includes(toStr(b!).toLowerCase())),
  replace: strict(3, 3, ([a, b, c]) => {
    const s = toStr(a!);
    const find = toStr(b!);
    return find ? cap(s.replace(find, () => toStr(c!))) : s;
  }),
  replaceAll: strict(3, 3, ([a, b, c]) => {
    const find = toStr(b!);
    return find ? cap(toStr(a!).split(find).join(toStr(c!))) : toStr(a!);
  }),
  lower: strict(1, 1, ([a]) => toStr(a!).toLowerCase()),
  upper: strict(1, 1, ([a]) => toStr(a!).toUpperCase()),
  trim: strict(1, 1, ([a]) => toStr(a!).trim()),
  repeat: strict(2, 2, ([a, n]) => {
    const count = Math.max(0, Math.floor(toNum(n!)) || 0);
    const s = toStr(a!);
    if (s.length * count > MAX_STRING) throw new FormulaError("Text is too long");
    return s.repeat(count);
  }),
  substring: strict(2, 3, ([a, s, e]) => toStr(a!).substring(toNum(s!) || 0, e === undefined ? undefined : toNum(e) || 0)),
  slice: strict(2, 3, ([a, s, e]) => (Array.isArray(a) ? a.slice(toNum(s!) || 0, e === undefined ? undefined : toNum(e) || 0) : toStr(a!).slice(toNum(s!) || 0, e === undefined ? undefined : toNum(e) || 0))),
  split: strict(2, 2, ([a, sep]) => capList(toStr(a!).split(toStr(sep!)).slice(0, MAX_LIST))),
  padStart: strict(3, 3, ([a, n, p]) => toStr(a!).padStart(Math.min(MAX_STRING, toNum(n!) || 0), toStr(p!) || " ")),
  round: strict(1, 2, ([a, p]) => {
    const places = Math.max(0, Math.min(10, Math.floor(p === undefined ? 0 : toNum(p) || 0)));
    const f = 10 ** places;
    return checkNum(Math.round(toNum(a!) * f) / f);
  }),
  ceil: numeric(Math.ceil),
  floor: numeric(Math.floor),
  abs: numeric(Math.abs),
  sqrt: numeric(Math.sqrt),
  cbrt: numeric(Math.cbrt),
  exp: numeric(Math.exp),
  ln: numeric(Math.log),
  log10: numeric(Math.log10),
  log2: numeric(Math.log2),
  sign: numeric(Math.sign),
  pow: numeric((a, b) => a ** b, 2, 2),
  mod: numeric((a, b) => a % b, 2, 2),
  pi: strict(0, 0, () => Math.PI),
  e: strict(0, 0, () => Math.E),
  min: strict(1, 100, (a) => {
    const nums = a.flatMap(asList).map(toNum).filter((n) => !Number.isNaN(n));
    return nums.length ? Math.min(...nums) : null;
  }),
  max: strict(1, 100, (a) => {
    const nums = a.flatMap(asList).map(toNum).filter((n) => !Number.isNaN(n));
    return nums.length ? Math.max(...nums) : null;
  }),
  sum: strict(1, 100, (a) => a.flatMap(asList).map(toNum).filter((n) => !Number.isNaN(n)).reduce((x, y) => x + y, 0)),
  mean: strict(1, 100, (a) => {
    const nums = a.flatMap(asList).map(toNum).filter((n) => !Number.isNaN(n));
    return nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : null;
  }),
  median: strict(1, 100, (a) => median(a.flatMap(asList).map(toNum).filter((n) => !Number.isNaN(n)))),
  now: strict(0, 0, (_a, env) => ({ t: "date", start: env.ctx.now, time: true })),
  today: strict(0, 0, (_a, env) => ({ t: "date", start: startOfDay(env.ctx.now), time: false })),
  dateAdd: strict(3, 3, ([d, n, u]) => {
    const date = asDate(d!);
    const unit = unitOf(u!);
    const amount = toNum(n!);
    return { t: "date", start: shift(date.start, amount, unit), ...(date.end !== undefined ? { end: shift(date.end, amount, unit) } : {}), time: date.time };
  }),
  dateSubtract: strict(3, 3, ([d, n, u]) => {
    const date = asDate(d!);
    const unit = unitOf(u!);
    const amount = -toNum(n!);
    return { t: "date", start: shift(date.start, amount, unit), ...(date.end !== undefined ? { end: shift(date.end, amount, unit) } : {}), time: date.time };
  }),
  dateBetween: strict(3, 3, ([a, b, u]) => between(asDate(a!).start, asDate(b!).start, unitOf(u!))),
  dateStart: strict(1, 1, ([d]) => ({ t: "date", start: asDate(d!).start, time: asDate(d!).time })),
  dateEnd: strict(1, 1, ([d]) => {
    const date = asDate(d!);
    return { t: "date", start: date.end ?? date.start, time: date.time };
  }),
  dateRange: strict(2, 2, ([a, b]) => ({ t: "date", start: asDate(a!).start, end: asDate(b!).start, time: asDate(a!).time })),
  formatDate: strict(2, 2, ([d, f]) => formatDateWith(asDate(d!).start, toStr(f!))),
  parseDate: strict(1, 1, ([s]) => {
    const p = parseDateString(toStr(s!).trim());
    return p ? { t: "date", start: p.ms, time: p.time } : null;
  }),
  timestamp: strict(1, 1, ([d]) => asDate(d!).start),
  fromTimestamp: strict(1, 1, ([n]) => {
    const ms = toNum(n!);
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new FormulaError("Number is out of range");
    return { t: "date", start: ms, time: true };
  }),
  year: strict(1, 1, ([d]) => new Date(asDate(d!).start).getFullYear()),
  month: strict(1, 1, ([d]) => new Date(asDate(d!).start).getMonth() + 1),
  date: strict(1, 1, ([d]) => new Date(asDate(d!).start).getDate()),
  day: strict(1, 1, ([d]) => new Date(asDate(d!).start).getDay()),
  week: strict(1, 1, ([d]) => {
    const t = new Date(asDate(d!).start);
    const first = new Date(t.getFullYear(), 0, 1);
    return Math.ceil(((t.getTime() - first.getTime()) / 86_400_000 + first.getDay() + 1) / 7);
  }),
  hour: strict(1, 1, ([d]) => new Date(asDate(d!).start).getHours()),
  minute: strict(1, 1, ([d]) => new Date(asDate(d!).start).getMinutes()),
  at: strict(2, 2, ([l, i]) => {
    const list = asList(l!);
    const n = Math.floor(toNum(i!));
    return list[n < 0 ? list.length + n : n] ?? null;
  }),
  first: strict(1, 1, ([l]) => asList(l!)[0] ?? null),
  last: strict(1, 1, ([l]) => asList(l!).at(-1) ?? null),
  reverse: strict(1, 1, ([l]) => [...asList(l!)].reverse()),
  sort: strict(1, 1, ([l]) => [...asList(l!)].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : toStr(a).localeCompare(toStr(b))))),
  unique: strict(1, 1, ([l]) => {
    const seen = new Set<string>();
    return asList(l!).filter((x) => {
      const k = JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }),
  flat: strict(1, 1, ([l]) => capList(asList(l!).flatMap((x) => asList(x)))),
  list: strict(0, 100, (a) => a),
  map: (env, args) => {
    const out: FValue[] = [];
    lambda(env, args[0]!, args[1], (_v, r) => void out.push(r));
    return capList(out);
  },
  filter: (env, args) => {
    const out: FValue[] = [];
    lambda(env, args[0]!, args[1], (v, r) => void (truthy(r) && out.push(v)));
    return out;
  },
  find: (env, args) => {
    let found: FValue = null;
    lambda(env, args[0]!, args[1], (v, r) => {
      if (truthy(r)) {
        found = v;
        return false;
      }
    });
    return found;
  },
  some: (env, args) => {
    let any = false;
    lambda(env, args[0]!, args[1], (_v, r) => {
      if (truthy(r)) {
        any = true;
        return false;
      }
    });
    return any;
  },
  every: (env, args) => {
    let all = true;
    lambda(env, args[0]!, args[1], (_v, r) => {
      if (!truthy(r)) {
        all = false;
        return false;
      }
    });
    return all;
  },
  count: strict(1, 1, ([l]) => asList(l!).length),
  let: (env, args) => {
    if (args.length !== 3 || args[0]!.k !== "name") throw new FormulaError("let() takes a name, a value and an expression");
    const name = (args[0] as { v: string }).v;
    const value = run(env, args[1]!);
    const prev = env.vars.get(name);
    env.vars.set(name, value);
    try {
      return run(env, args[2]!);
    } finally {
      if (prev === undefined) env.vars.delete(name);
      else env.vars.set(name, prev);
    }
  },
  id: strict(0, 1, ([p], env) => (p && typeof p === "object" && !Array.isArray(p) && "id" in p ? (p as FPage).id : env.row.id)),
  name: strict(1, 1, ([p]) => (p && typeof p === "object" && !Array.isArray(p) && p.t === "person" ? p.name : toStr(p!))),
  style: strict(1, 10, ([a]) => toStr(a!)),
  link: strict(2, 2, ([a]) => toStr(a!)),
};

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS).sort();

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function run(env: Env, ast: Ast): FValue {
  if (++env.steps.n > MAX_STEPS) throw new FormulaError("Formula takes too long");
  switch (ast.k) {
    case "lit":
      return ast.v;
    case "list":
      return capList(ast.items.map((i) => run(env, i)));
    case "name": {
      if (env.vars.has(ast.v)) return env.vars.get(ast.v)!;
      if (ast.v === "pi") return Math.PI;
      if (ast.v === "e") return Math.E;
      throw new FormulaError(`Unknown name "${ast.v.slice(0, 40)}"`);
    }
    case "call": {
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, ast.fn) ? FUNCTIONS[ast.fn] : undefined;
      if (!fn) throw new FormulaError(`Unknown function "${ast.fn.slice(0, 40)}"`);
      return fn(env, ast.args);
    }
    case "un": {
      const a = run(env, ast.a);
      if (ast.op === "!") return !truthy(a);
      if (ast.op === "+") return checkNum(toNum(a));
      return checkNum(-arith(a));
    }
    case "cond":
      return truthy(run(env, ast.c)) ? run(env, ast.a) : run(env, ast.b);
    case "bin": {
      if (ast.op === "&&") return truthy(run(env, ast.a)) && truthy(run(env, ast.b));
      if (ast.op === "||") return truthy(run(env, ast.a)) || truthy(run(env, ast.b));
      const a = run(env, ast.a);
      const b = run(env, ast.b);
      switch (ast.op) {
        case "+":
          if (typeof a === "string" || typeof b === "string") return cap(toStr(a) + toStr(b));
          if (Array.isArray(a) && Array.isArray(b)) return capList([...a, ...b]);
          return checkNum(arith(a) + arith(b));
        case "-":
          if (isDate(a) && isDate(b)) return a.start - b.start;
          return checkNum(arith(a) - arith(b));
        case "*":
          return checkNum(arith(a) * arith(b));
        case "/":
          return arith(b) === 0 ? null : checkNum(arith(a) / arith(b));
        case "%":
          return arith(b) === 0 ? null : checkNum(arith(a) % arith(b));
        case "^":
          return checkNum(arith(a) ** arith(b));
        case "==":
          return equal(a, b);
        case "!=":
          return !equal(a, b);
        case ">":
          return compare(a, b) > 0;
        case "<":
          return compare(a, b) < 0;
        case ">=":
          return compare(a, b) >= 0;
        case "<=":
          return compare(a, b) <= 0;
      }
      throw new FormulaError("Unknown operator");
    }
  }
}

export function evaluateFormula(ctx: DbContext, row: PageMeta, expression: string): FValue | FError {
  if (!expression.trim()) return null;
  const ast = compileFormula(expression);
  if ("error" in ast && !("k" in ast)) return ast;
  try {
    return run({ ctx, row, steps: { n: 0 }, vars: new Map() }, ast as Ast);
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    if (e instanceof RangeError) return { error: "Formula is too complex" };
    throw e;
  }
}

export function formulaValue(ctx: DbContext, row: PageMeta, prop: Property): FValue | FError {
  const key = `${ctx.database}:${row.id}:${prop.id}`;
  const cached = ctx.cache.get(key);
  if (cached !== undefined) return cached;
  if (ctx.stack.has(key)) return { error: "Formula refers to itself" };
  if (ctx.stack.size > 30) return { error: "Formula is too complex" };
  ctx.stack.add(key);
  try {
    const value = evaluateFormula(ctx, row, prop.expression);
    ctx.cache.set(key, value);
    return value;
  } finally {
    ctx.stack.delete(key);
  }
}

export function subContext(ctx: DbContext, database: string): DbContext | null {
  const schema = ctx.schemaFor(database);
  if (!schema) return null;
  return { ...ctx, database, schema, rows: rowsOf(ctx, database) };
}

function rowsOf(ctx: DbContext, database: string): PageMeta[] {
  return database === ctx.database ? ctx.rows : ctx.rowsFor(database);
}

export function rollupValue(ctx: DbContext, row: PageMeta, prop: Property): FValue | FError {
  const key = `${ctx.database}:${row.id}:${prop.id}`;
  const cached = ctx.cache.get(key);
  if (cached !== undefined) return cached;
  if (ctx.stack.has(key)) return { error: "Rollup refers to itself" };
  if (ctx.stack.size > 30) return { error: "Rollup is too complex" };
  ctx.stack.add(key);
  try {
    const relation = ctx.schema.find((p) => p.id === prop.rollupRelation && p.type === "relation");
    if (!relation) return null;
    const related = idsValue(row, relation)
      .map((id) => ctx.page(id))
      .filter((p): p is PageMeta => !!p && !p.deleted && !p.archivedAt);
    const sub = relation.relation ? subContext(ctx, relation.relation) : null;
    const target = sub?.schema.find((p) => p.id === prop.rollupTarget) ?? (prop.rollupTarget === TITLE ? readProperty(new Y.Map(), TITLE) : undefined);
    const values: (FValue | FError)[] = target ? related.map((r) => fvalue(sub ?? ctx, r, target)) : related.map((r) => r.title);
    const value = aggregate(prop.rollupFn, values, ctx.now);
    ctx.cache.set(key, value);
    return value;
  } finally {
    ctx.stack.delete(key);
  }
}

export function aggregate(fn: RollupFn | CalcFn, values: (FValue | FError)[], _now = Date.now()): FValue {
  const clean = values.map((v) => (isError(v) ? null : v));
  const flat = clean.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const nums = flat.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const dates = flat.filter((v): v is FDate => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "date");
  const total = clean.length;
  const empties = clean.filter((v) => isEmptyF(v)).length;
  const checked = clean.filter((v) => v === true).length;
  const pct = (n: number) => (total ? Math.round((n / total) * 10000) / 10000 : 0);
  switch (fn) {
    case "show_original":
      return flat.filter((v) => v !== null && v !== "");
    case "none":
      return null;
    case "count":
      return total;
    case "count_values":
      return flat.filter((v) => !isEmptyF(v)).length;
    case "unique":
      return new Set(flat.filter((v) => !isEmptyF(v)).map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))).size;
    case "empty":
      return empties;
    case "not_empty":
      return total - empties;
    case "percent_empty":
      return pct(empties);
    case "percent_not_empty":
      return pct(total - empties);
    case "checked":
      return checked;
    case "unchecked":
      return total - checked;
    case "percent_checked":
      return pct(checked);
    case "percent_unchecked":
      return pct(total - checked);
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "median":
      return median(nums);
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "earliest": {
      if (!dates.length) return null;
      const first = dates.reduce((a, b) => (b.start < a.start ? b : a));
      return { t: "date", start: first.start, time: first.time };
    }
    case "latest": {
      if (!dates.length) return null;
      const last = dates.reduce((a, b) => ((b.end ?? b.start) > (a.end ?? a.start) ? b : a));
      return { t: "date", start: last.end ?? last.start, time: last.time };
    }
    case "date_range": {
      if (!dates.length) return null;
      return Math.round((Math.max(...dates.map((d) => d.end ?? d.start)) - Math.min(...dates.map((d) => d.start))) / 86_400_000);
    }
  }
}

export const CALC_LABELS: Record<CalcFn, string> = {
  none: "None",
  count: "Count all",
  count_values: "Count values",
  unique: "Count unique values",
  empty: "Count empty",
  not_empty: "Count not empty",
  percent_empty: "Percent empty",
  percent_not_empty: "Percent not empty",
  checked: "Checked",
  unchecked: "Unchecked",
  percent_checked: "Percent checked",
  percent_unchecked: "Percent unchecked",
  sum: "Sum",
  avg: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  earliest: "Earliest date",
  latest: "Latest date",
  date_range: "Date range",
};

export const ROLLUP_LABELS: Record<RollupFn, string> = { ...CALC_LABELS, show_original: "Show original" } as Record<RollupFn, string>;

export function calcsFor(kind: Kind): CalcFn[] {
  const base: CalcFn[] = ["none", "count", "count_values", "unique", "empty", "not_empty", "percent_empty", "percent_not_empty"];
  if (kind === "number") return [...base, "sum", "avg", "median", "min", "max", "range"];
  if (kind === "date") return [...base, "earliest", "latest", "date_range"];
  if (kind === "checkbox") return ["none", "count", "checked", "unchecked", "percent_checked", "percent_unchecked"];
  return base;
}

export function calculate(ctx: DbContext, rows: PageMeta[], prop: Property, fn: CalcFn): string {
  if (fn === "none") return "";
  const values = rows.map((r) => (prop.type === "checkbox" ? checkValue(r, prop) : fvalue(ctx, r, prop)));
  const result = aggregate(fn, values, ctx.now);
  if (fn.startsWith("percent")) return `${Math.round((result as number) * 1000) / 10}%`;
  if (fn === "date_range") return result === null ? "" : `${result} day${result === 1 ? "" : "s"}`;
  if (fn === "sum" || fn === "avg" || fn === "median" || fn === "min" || fn === "max" || fn === "range") {
    if (typeof result !== "number") return "";
    const rounded = Math.round(result * 100) / 100;
    return prop.type === "number" ? formatNumber(rounded, prop.format) : String(rounded);
  }
  return fToText(result, prop, ctx.now);
}

function relativeRange(range: RelativeRange, now: number): [number, number] {
  const today = startOfDay(now);
  switch (range) {
    case "today":
      return [today, addDays(today, 1)];
    case "tomorrow":
      return [addDays(today, 1), addDays(today, 2)];
    case "yesterday":
      return [addDays(today, -1), today];
    case "past_week":
      return [addDays(today, -7), addDays(today, 1)];
    case "past_month":
      return [addMonths(today, -1), addDays(today, 1)];
    case "past_year":
      return [addMonths(today, -12), addDays(today, 1)];
    case "next_week":
      return [today, addDays(today, 8)];
    case "next_month":
      return [today, addDays(addMonths(today, 1), 1)];
    case "next_year":
      return [today, addDays(addMonths(today, 12), 1)];
    case "this_week":
      return [startOfWeek(now), addDays(startOfWeek(now), 7)];
    case "this_month": {
      const d = new Date(now);
      return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
    }
    case "this_year": {
      const d = new Date(now);
      return [new Date(d.getFullYear(), 0, 1).getTime(), new Date(d.getFullYear() + 1, 0, 1).getTime()];
    }
  }
}

export function condsFor(kind: Kind): { id: FilterCond; label: string }[] {
  const empty = [
    { id: "empty" as const, label: "Is empty" },
    { id: "not_empty" as const, label: "Is not empty" },
  ];
  switch (kind) {
    case "number":
      return [
        { id: "eq", label: "=" },
        { id: "neq", label: "≠" },
        { id: "gt", label: ">" },
        { id: "lt", label: "<" },
        { id: "gte", label: "≥" },
        { id: "lte", label: "≤" },
        ...empty,
      ];
    case "select":
      return [{ id: "is", label: "Is" }, { id: "is_not", label: "Is not" }, ...empty];
    case "multi":
    case "person":
    case "relation":
    case "files":
      return [{ id: "contains", label: "Contains" }, { id: "not_contains", label: "Does not contain" }, ...empty];
    case "date":
      return [
        { id: "is", label: "Is" },
        { id: "before", label: "Is before" },
        { id: "after", label: "Is after" },
        { id: "on_or_before", label: "Is on or before" },
        { id: "on_or_after", label: "Is on or after" },
        { id: "between", label: "Is between" },
        { id: "relative", label: "Is within" },
        ...empty,
      ];
    case "checkbox":
      return [
        { id: "checked", label: "Is checked" },
        { id: "unchecked", label: "Is not checked" },
      ];
    default:
      return [
        { id: "is", label: "Is" },
        { id: "is_not", label: "Is not" },
        { id: "contains", label: "Contains" },
        { id: "not_contains", label: "Does not contain" },
        { id: "starts", label: "Starts with" },
        { id: "ends", label: "Ends with" },
        ...empty,
      ];
  }
}

export function defaultCond(kind: Kind): FilterCond {
  return condsFor(kind)[0]!.id;
}

export const isValueless = (cond: FilterCond) => cond === "empty" || cond === "not_empty" || cond === "checked" || cond === "unchecked";

export function ruleIsActive(rule: FilterRule): boolean {
  if (isValueless(rule.cond)) return true;
  const v = rule.value;
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function filterDay(v: unknown, now: number): [number, number] | null {
  if (!v || typeof v !== "object") {
    const p = parseDateString(v);
    return p ? [startOfDay(p.ms), addDays(startOfDay(p.ms), 1)] : null;
  }
  const r = v as Record<string, unknown>;
  if (typeof r.relative === "string") return relativeRange(r.relative as RelativeRange, now);
  const p = parseDateString(r.date ?? r.start);
  return p ? [startOfDay(p.ms), addDays(startOfDay(p.ms), 1)] : null;
}

function idsOf(ctx: DbContext, row: PageMeta, prop: Property, kind: Kind): string[] {
  if (prop.type === "formula" || prop.type === "rollup") {
    const v = fvalue(ctx, row, prop);
    return (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === "object" && !Array.isArray(x) && "id" in x ? x.id : fToText(x as FValue))).filter(Boolean);
  }
  if (kind === "files") return filesValue(row, prop).map((f) => f.name);
  return idsValue(row, prop);
}

export function matchRule(ctx: DbContext, row: PageMeta, rule: FilterRule): boolean {
  const prop = ctx.schema.find((p) => p.id === rule.prop);
  if (!prop || !ruleIsActive(rule)) return true;
  const kind = kindOf(ctx, prop);
  const computed = prop.type === "formula" || prop.type === "rollup";
  const fv = fvalue(ctx, row, prop);
  const empty = prop.type === "checkbox" ? !checkValue(row, prop) : isEmptyF(fv);
  if (rule.cond === "empty") return empty;
  if (rule.cond === "not_empty") return !empty;
  switch (kind) {
    case "checkbox": {
      const on = prop.type === "checkbox" ? checkValue(row, prop) : fv === true;
      return rule.cond === "checked" ? on : rule.cond === "unchecked" ? !on : on === (rule.value === true);
    }
    case "number": {
      const n = typeof fv === "number" ? fv : null;
      const target = Number(rule.value);
      if (!Number.isFinite(target)) return true;
      if (n === null) return rule.cond === "neq";
      switch (rule.cond) {
        case "eq":
          return n === target;
        case "neq":
          return n !== target;
        case "gt":
          return n > target;
        case "lt":
          return n < target;
        case "gte":
          return n >= target;
        case "lte":
          return n <= target;
        default:
          return true;
      }
    }
    case "select": {
      const wanted = asStrings(rule.value);
      const have = computed ? fToText(fv) : (row.props[prop.id] as string | undefined) ?? "";
      const hit = wanted.some((w) => w === have || (computed && w.toLowerCase() === String(have).toLowerCase()));
      return rule.cond === "is_not" ? !hit : hit;
    }
    case "multi":
    case "person":
    case "relation":
    case "files": {
      const wanted = asStrings(rule.value);
      const have = new Set(idsOf(ctx, row, prop, kind));
      const textual = kind === "files" || (kind === "multi" && computed);
      const hit = wanted.some((w) => (textual ? [...have].some((h) => h.toLowerCase().includes(w.toLowerCase())) : have.has(w)));
      return rule.cond === "not_contains" ? !hit : hit;
    }
    case "date": {
      const d = isError(fv) ? null : Array.isArray(fv) ? (fv.find((x) => x && typeof x === "object" && !Array.isArray(x) && x.t === "date") as FDate | undefined) ?? null : (fv as FDate | null);
      if (rule.cond === "between") {
        const r = rule.value as Record<string, unknown> | undefined;
        const a = filterDay(r?.start, ctx.now);
        const b = filterDay(r?.end, ctx.now);
        if (!a || !b) return true;
        if (!d) return false;
        return (d.end ?? d.start) >= a[0] && d.start < b[1];
      }
      const range = filterDay(rule.value, ctx.now);
      if (!range) return true;
      if (!d) return false;
      const start = d.start;
      const end = d.end ?? d.start;
      switch (rule.cond) {
        case "is":
        case "relative":
          return end >= range[0] && start < range[1];
        case "before":
          return start < range[0];
        case "after":
          return start >= range[1];
        case "on_or_before":
          return start < range[1];
        case "on_or_after":
          return end >= range[0];
        default:
          return true;
      }
    }
    default: {
      const have = fToText(fv).toLowerCase();
      const want = String(rule.value ?? "").toLowerCase();
      switch (rule.cond) {
        case "is":
          return have === want;
        case "is_not":
          return have !== want;
        case "contains":
          return have.includes(want);
        case "not_contains":
          return !have.includes(want);
        case "starts":
          return have.startsWith(want);
        case "ends":
          return have.endsWith(want);
        default:
          return true;
      }
    }
  }
}

export function matchFilter(ctx: DbContext, row: PageMeta, group: FilterGroup): boolean {
  const active = group.rules.filter((r) => r.kind === "group" ? r.rules.length > 0 : ruleIsActive(r));
  if (!active.length) return true;
  const test = (r: FilterRule | FilterGroup) => (r.kind === "group" ? matchFilter(ctx, row, r) : matchRule(ctx, row, r));
  return group.op === "or" ? active.some(test) : active.every(test);
}

function draftRow(ctx: DbContext, props: Record<string, unknown>): PageMeta {
  return { id: "__draft__", title: "", icon: "", cover: "", coverY: 0, parent: ctx.database, order: "", kind: "page", createdAt: ctx.now, createdBy: "", updatedAt: ctx.now, updatedBy: "", archivedAt: 0, deleted: false, font: "default", fullWidth: false, smallText: false, locked: false, isTemplate: false, props } as PageMeta;
}

function dayValue(ms: number): DateValue {
  return { start: toDateString(ms) } as DateValue;
}

function valueForRule(ctx: DbContext, prop: Property, rule: FilterRule): { value: unknown } | null {
  const kind = kindOf(ctx, prop);
  const v = rule.value;
  const first = asStrings(v)[0];
  if (rule.cond === "empty") return { value: prop.type === "checkbox" ? false : prop.type === "multi_select" || prop.type === "person" || prop.type === "relation" || prop.type === "files" ? [] : null };
  switch (kind) {
    case "checkbox":
      if (rule.cond === "checked" || rule.cond === "not_empty") return { value: true };
      if (rule.cond === "unchecked") return { value: false };
      return { value: v === true };
    case "select":
      if (rule.cond === "is_not") return { value: null };
      if (rule.cond === "not_empty") return prop.options[0] ? { value: prop.options[0].id } : null;
      return first ? { value: first } : null;
    case "multi":
    case "person":
    case "relation":
      if (rule.cond === "not_contains") return { value: [] };
      if (rule.cond === "not_empty") return kind === "multi" && prop.options[0] ? { value: [prop.options[0].id] } : null;
      return first ? { value: [first] } : null;
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n) || v === "" || v === null || v === undefined) return null;
      if (rule.cond === "gt") return { value: n + 1 };
      if (rule.cond === "lt") return { value: n - 1 };
      if (rule.cond === "neq") return null;
      return { value: n };
    }
    case "date": {
      if (rule.cond === "not_empty") return { value: dayValue(ctx.now) };
      if (rule.cond === "between") {
        const range = filterDay((v as Record<string, unknown> | undefined)?.start, ctx.now);
        return range ? { value: dayValue(range[0]) } : null;
      }
      const range = filterDay(v, ctx.now);
      if (!range) return null;
      if (rule.cond === "before") return { value: dayValue(addDays(range[0], -1)) };
      if (rule.cond === "after") return { value: dayValue(range[1]) };
      return { value: dayValue(range[0]) };
    }
    case "text":
      if (typeof v !== "string" || !v) return null;
      return rule.cond === "is" || rule.cond === "contains" || rule.cond === "starts" || rule.cond === "ends" ? { value: v } : null;
    default:
      return null;
  }
}

export function prefillForFilter(ctx: DbContext, filter: FilterGroup, base: Record<string, unknown> = {}): Record<string, unknown> {
  const fixed = new Set(Object.keys(base));
  const matches = (props: Record<string, unknown>, node: FilterRule | FilterGroup) => {
    const row = draftRow(ctx, props);
    return node.kind === "group" ? matchFilter(ctx, row, node) : matchRule(ctx, row, node);
  };
  const satisfy = (props: Record<string, unknown>, node: FilterRule | FilterGroup): Record<string, unknown> => {
    if (matches(props, node)) return props;
    if (node.kind === "rule") {
      const prop = ctx.schema.find((p) => p.id === node.prop);
      if (!prop || fixed.has(prop.id) || !isEditable(prop.type) || prop.type === "title") return props;
      const next = valueForRule(ctx, prop, node);
      return next ? { ...props, [prop.id]: next.value } : props;
    }
    const active = node.rules.filter((r) => (r.kind === "group" ? r.rules.length > 0 : ruleIsActive(r)));
    if (node.op === "and") return active.reduce(satisfy, props);
    for (const option of active) {
      const tried = satisfy(props, option);
      if (matches(tried, option)) return tried;
    }
    return props;
  };
  return satisfy({ ...base }, filter);
}

export function countFilterRules(group: FilterGroup): number {
  return group.rules.reduce((n, r) => n + (r.kind === "group" ? countFilterRules(r) : 1), 0);
}

export function matchSearch(ctx: DbContext, row: PageMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.title.toLowerCase().includes(q)) return true;
  for (const prop of ctx.schema) {
    if (prop.type === "title" || prop.type === "files" || prop.type === "relation") continue;
    if (prop.type === "formula" || prop.type === "rollup") continue;
    const v = fvalue(ctx, row, prop);
    if (fToText(v, prop, ctx.now).toLowerCase().includes(q)) return true;
  }
  return false;
}

function sortKey(ctx: DbContext, row: PageMeta, prop: Property): number | string | null {
  switch (prop.type) {
    case "select":
    case "status": {
      const v = row.props[prop.id];
      const i = prop.options.findIndex((o) => o.id === v);
      return i < 0 ? null : i;
    }
    case "multi_select": {
      const ids = idsValue(row, prop);
      const i = Math.min(...ids.map((id) => prop.options.findIndex((o) => o.id === id)).filter((x) => x >= 0));
      return Number.isFinite(i) ? i : null;
    }
    case "checkbox":
      return checkValue(row, prop) ? 1 : 0;
    case "created_time":
      return row.createdAt;
    case "edited_time":
      return row.updatedAt;
    default: {
      const v = fvalue(ctx, row, prop);
      if (isEmptyF(v)) return null;
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v && typeof v === "object" && !Array.isArray(v) && "t" in v && v.t === "date") return v.start;
      if (Array.isArray(v) && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) && (v[0] as FDate).t === "date") return (v[0] as FDate).start;
      return fToText(v as FValue).toLowerCase();
    }
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortRows(ctx: DbContext, rows: PageMeta[], sorts: SortRule[]): PageMeta[] {
  const active = sorts.map((s) => ({ s, prop: ctx.schema.find((p) => p.id === s.prop) })).filter((x): x is { s: SortRule; prop: Property } => !!x.prop);
  const base = (a: PageMeta, b: PageMeta) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!active.length) return [...rows].sort(base);
  const keyed = rows.map((row) => ({ row, keys: active.map((a) => sortKey(ctx, row, a.prop)) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < active.length; i++) {
      const a = x.keys[i]!;
      const b = y.keys[i]!;
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const c = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
      if (c !== 0) return active[i]!.s.dir === "desc" ? -c : c;
    }
    return base(x.row, y.row);
  });
  return keyed.map((k) => k.row);
}

export type Group = { key: string; label: string; color: Color; option?: SelectOption; person?: Person; rows: PageMeta[]; empty: boolean; hidden: boolean; collapsed: boolean };

export const NONE = "__none__";

function dateBucket(ms: number, by: GroupBy["date"], now: number): { key: string; label: string; sort: number } {
  const d = new Date(ms);
  switch (by) {
    case "day":
      return { key: toDateString(ms), label: formatDay(ms, "full"), sort: startOfDay(ms) };
    case "week": {
      const w = startOfWeek(ms);
      return { key: `w:${toDateString(w)}`, label: `Week of ${formatDay(w, "full")}`, sort: w };
    }
    case "month":
      return { key: `m:${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, sort: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
    case "year":
      return { key: `y:${d.getFullYear()}`, label: String(d.getFullYear()), sort: new Date(d.getFullYear(), 0, 1).getTime() };
    default: {
      const diff = daysBetween(now, ms);
      if (diff === 0) return { key: "r:today", label: "Today", sort: 3 };
      if (diff === 1) return { key: "r:tomorrow", label: "Tomorrow", sort: 4 };
      if (diff === -1) return { key: "r:yesterday", label: "Yesterday", sort: 2 };
      if (diff > 1 && diff <= 7) return { key: "r:next7", label: "Next 7 days", sort: 5 };
      if (diff < -1 && diff >= -7) return { key: "r:last7", label: "Last 7 days", sort: 1 };
      if (diff > 7 && diff <= 30) return { key: "r:next30", label: "Next 30 days", sort: 6 };
      if (diff < -7 && diff >= -30) return { key: "r:last30", label: "Last 30 days", sort: 0 };
      const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      return { key: `m:${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, sort: diff > 0 ? 1e13 + month : -1e13 + month };
    }
  }
}

export type GroupKeyInfo = { key: string; label: string; color?: Color; sort: number | string; option?: SelectOption; person?: Person };

export function groupKeysOf(ctx: DbContext, row: PageMeta, prop: Property, by: GroupBy): GroupKeyInfo[] {
  switch (prop.type) {
    case "select":
    case "status": {
      const option = selectValue(row, prop);
      if (!option) return [];
      if (prop.type === "status" && by.status === "group") {
        const g = STATUS_GROUPS.find((x) => x.id === (option.group ?? "todo"))!;
        return [{ key: g.id, label: g.name, color: g.color, sort: STATUS_GROUPS.indexOf(g) }];
      }
      return [{ key: option.id, label: option.name, color: option.color, sort: prop.options.indexOf(option), option }];
    }
    case "multi_select":
      return multiValue(row, prop).map((o) => ({ key: o.id, label: o.name, color: o.color, sort: prop.options.indexOf(o), option: o }));
    case "person":
    case "created_by":
    case "edited_by":
      return idsValue(row, prop).map((id) => {
        const person = ctx.people.get(id) ?? { id, name: "Someone", color: "#888" };
        return { key: id, label: person.name, sort: person.name.toLowerCase(), person };
      });
    case "checkbox": {
      const on = checkValue(row, prop);
      return [{ key: on ? "true" : "false", label: on ? "Checked" : "Unchecked", sort: on ? 1 : 0 }];
    }
    case "relation":
      return idsValue(row, prop)
        .map((id) => ctx.page(id))
        .filter((p): p is PageMeta => !!p && !p.deleted)
        .map((p) => ({ key: p.id, label: p.title || "Untitled", sort: (p.title || "Untitled").toLowerCase() }));
    case "number":
    case "id": {
      const n = numberValue(row, prop);
      if (n === null) return [];
      const lo = Math.floor(n / by.step) * by.step;
      return [{ key: String(lo), label: `${formatNumber(lo, prop.format)} to ${formatNumber(lo + by.step, prop.format)}`, sort: lo }];
    }
    case "date":
    case "created_time":
    case "edited_time": {
      const d = dateToF(dateValue(row, prop));
      if (!d) return [];
      const b = dateBucket(d.start, by.date, ctx.now);
      return [{ key: b.key, label: b.label, sort: b.sort }];
    }
    default: {
      const v = fvalue(ctx, row, prop);
      if (isEmptyF(v)) return [];
      if (Array.isArray(v)) return v.filter((x) => !isEmptyF(x)).map((x) => ({ key: fToText(x), label: fToText(x), sort: fToText(x).toLowerCase() }));
      if (typeof v === "number") return [{ key: String(v), label: fToText(v), sort: v }];
      if (typeof v === "boolean") return [{ key: String(v), label: v ? "Checked" : "Unchecked", sort: v ? 1 : 0 }];
      if (v && typeof v === "object" && "t" in v && v.t === "date") {
        const b = dateBucket(v.start, by.date, ctx.now);
        return [{ key: b.key, label: b.label, sort: b.sort }];
      }
      const text = fToText(v as FValue);
      if (by.text === "alpha") {
        const ch = text.trim().charAt(0).toUpperCase();
        const key = /[A-Z]/.test(ch) ? ch : "#";
        return [{ key, label: key, sort: key }];
      }
      return [{ key: text, label: text, sort: text.toLowerCase() }];
    }
  }
}

export function emptyGroupLabel(prop: Property) {
  return `No ${prop.name || typeLabel(prop.type)}`;
}

export function groupRows(ctx: DbContext, rows: PageMeta[], by: GroupBy, states: Record<string, GroupState>): Group[] {
  const prop = ctx.schema.find((p) => p.id === by.prop);
  if (!prop) return [{ key: "all", label: "", color: "default", rows, empty: false, hidden: false, collapsed: false }];
  const buckets = new Map<string, { info: GroupKeyInfo; rows: PageMeta[] }>();
  const ensure = (info: GroupKeyInfo) => {
    let b = buckets.get(info.key);
    if (!b) {
      b = { info, rows: [] };
      buckets.set(info.key, b);
    }
    return b;
  };
  if ((prop.type === "select" || prop.type === "multi_select" || prop.type === "status") && !(prop.type === "status" && by.status === "group"))
    prop.options.forEach((o, i) => ensure({ key: o.id, label: o.name, color: o.color, sort: i, option: o }));
  if (prop.type === "status" && by.status === "group") STATUS_GROUPS.forEach((g, i) => ensure({ key: g.id, label: g.name, color: g.color, sort: i }));
  if (prop.type === "checkbox") {
    ensure({ key: "false", label: "Unchecked", sort: 0 });
    ensure({ key: "true", label: "Checked", sort: 1 });
  }
  if (prop.type === "person") for (const person of ctx.people.values()) ensure({ key: person.id, label: person.name, sort: person.name.toLowerCase(), person });
  const none: PageMeta[] = [];
  for (const row of rows) {
    const keys = groupKeysOf(ctx, row, prop, by);
    if (!keys.length) none.push(row);
    for (const info of keys) ensure(info).rows.push(row);
  }
  const fixedEmptyFirst = prop.type === "select" || prop.type === "status" || prop.type === "multi_select" || prop.type === "person";
  let list = [...buckets.values()];
  const cmp = (a: GroupKeyInfo, b: GroupKeyInfo) => (typeof a.sort === "number" && typeof b.sort === "number" ? a.sort - b.sort : collator.compare(String(a.sort), String(b.sort)));
  list.sort((a, b) => cmp(a.info, b.info));
  if (by.sort === "desc") list.reverse();
  const manual = list.some((b) => states[b.info.key]?.order);
  if (manual && by.sort === "manual") {
    list = list.map((b, i) => ({ b, k: states[b.info.key]?.order || `~${String(i).padStart(5, "0")}` })).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0)).map((x) => x.b);
  }
  const groups: Group[] = list.map(({ info, rows: rs }) => ({
    key: info.key,
    label: info.label,
    color: info.color ?? "default",
    ...(info.option ? { option: info.option } : {}),
    ...(info.person ? { person: info.person } : {}),
    rows: rs,
    empty: false,
    hidden: states[info.key]?.hidden === true,
    collapsed: states[info.key]?.collapsed === true,
  }));
  const noneGroup: Group = { key: NONE, label: emptyGroupLabel(prop), color: "default", rows: none, empty: true, hidden: states[NONE]?.hidden === true, collapsed: states[NONE]?.collapsed === true };
  if (fixedEmptyFirst) groups.unshift(noneGroup);
  else groups.push(noneGroup);
  return by.hideEmpty ? groups.map((g) => (g.rows.length === 0 ? { ...g, hidden: true } : g)) : groups;
}

export type ViewResult = { rows: PageMeta[]; groups: Group[] | null; total: number };

export function computeView(ctx: DbContext, view: View, search = "", keep?: ReadonlySet<string>): ViewResult {
  const filtered = ctx.rows.filter((r) => keep?.has(r.id) || (matchFilter(ctx, r, view.filter) && matchSearch(ctx, r, search)));
  const rows = sortRows(ctx, filtered, view.sorts);
  const groups = view.groupBy && view.type !== "calendar" && view.type !== "chart" ? groupRows(ctx, rows, view.groupBy, view.groups) : null;
  return { rows, groups, total: rows.length };
}

const RELATIVE_GROUP_DAYS: Record<string, number> = { "r:today": 0, "r:tomorrow": 1, "r:yesterday": -1, "r:next7": 2, "r:last7": -2, "r:next30": 8, "r:last30": -8 };

export function groupValueFor(ctx: DbContext, prop: Property, key: string): unknown {
  if (key === NONE) return null;
  switch (prop.type) {
    case "select":
    case "status":
      if (prop.type === "status" && STATUS_GROUPS.some((g) => g.id === key)) return prop.options.find((o) => o.group === key)?.id ?? null;
      return key;
    case "checkbox":
      return key === "true";
    case "number":
      return Number(key);
    case "date": {
      const iso = key.replace(/^[wmy]:/, "");
      const s = /^\d{4}$/.test(iso) ? `${iso}-01-01` : /^\d{4}-\d{2}$/.test(iso) ? `${iso}-01` : iso;
      if (parseDateString(s)) return { start: s };
      const offset = RELATIVE_GROUP_DAYS[key];
      return offset === undefined ? null : { start: toDateString(addDays(startOfDay(ctx.now), offset)) };
    }
    default:
      return key;
  }
}

export function moveToGroupValue(ctx: DbContext, row: PageMeta, prop: Property, from: string, to: string): unknown {
  const current = rawValue(row, prop);
  if (prop.type === "multi_select" || prop.type === "person" || prop.type === "relation") {
    const list = asStrings(current).filter((x) => x !== from);
    if (to !== NONE && !list.includes(to)) list.push(to);
    return to === NONE ? [] : list;
  }
  if (prop.type === "date") {
    const target = groupValueFor(ctx, prop, to) as DateValue | null;
    if (!target) return null;
    const old = dateValue(row, prop);
    if (old?.end) {
      const s = parseDateString(old.start)!;
      const e = parseDateString(old.end)!;
      const t = parseDateString(target.start)!;
      return { start: toDateString(t.ms, s.time), end: toDateString(t.ms + (e.ms - s.ms), s.time) };
    }
    return target;
  }
  return groupValueFor(ctx, prop, to);
}

export const isEditable = (type: PropType) => !["formula", "rollup", "created_time", "created_by", "edited_time", "edited_by", "id"].includes(type);

export function databaseRows(tree: Y.Doc, database: PageId, options: { templates?: boolean } = {}): PageMeta[] {
  return childrenOf(tree, database).filter((p) => p.kind === "page" && p.isTemplate === (options.templates === true));
}

export function nextIdNumber(tree: Y.Doc, database: PageId, prop: string): number {
  let max = 0;
  for (const row of childrenOf(tree, database, { archived: true })) {
    const v = row.props[prop];
    if (typeof v === "number" && v > max) max = v;
  }
  return max + 1;
}

export type NewRow = { by: string; title?: string; after?: PageId | null; props?: Record<string, unknown>; id?: PageId; now?: number; isTemplate?: boolean };

export function createRow(tree: Y.Doc, database: PageId, schema: Property[], input: NewRow): PageId {
  let id = "";
  tree.transact(() => {
    const props: Record<string, unknown> = { ...(input.props ?? {}) };
    for (const p of schema) if (p.type === "id" && props[p.id] === undefined) props[p.id] = nextIdNumber(tree, database, p.id);
    id = createPage(tree, { ...(input.id ? { id: input.id } : {}), parent: database, kind: "page", title: input.title ?? "", ...(input.after !== undefined ? { after: input.after } : {}), props, by: input.by, ...(input.now ? { now: input.now } : {}) });
    if (input.isTemplate) pagesOf(tree).get(id)?.set("isTemplate", true);
  });
  return id;
}

export function setCell(tree: Y.Doc, row: PageId, prop: Property, value: unknown, by: string) {
  if (prop.type === "title") {
    const entry = pagesOf(tree).get(row);
    if (!entry) return;
    tree.transact(() => {
      entry.set("title", String(value ?? "").slice(0, 2000));
      entry.set("updatedAt", Date.now());
      entry.set("updatedBy", by);
    });
    return;
  }
  if (!isEditable(prop.type)) return;
  const clean = cleanCellValue(prop, value);
  setProp(tree, row, prop.id, clean, by);
}

export function cleanCellValue(prop: Property, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return String(value).slice(0, 20_000) || null;
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[, $€£¥₹%]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "select":
    case "status":
      return typeof value === "string" && value ? value : null;
    case "multi_select":
    case "person":
    case "relation":
      return asStrings(value).slice(0, 500);
    case "date":
      return cleanDate(value);
    case "checkbox":
      return value === true;
    case "files":
      return cleanFiles(value).slice(0, 100);
    default:
      return value;
  }
}

export function setRelation(tree: Y.Doc, row: PageId, prop: Property, ids: string[], by: string) {
  tree.transact(() => {
    const before = new Set(asStrings(getPage(tree, row)?.props[prop.id]));
    const after = [...new Set(ids)].filter((id) => id !== row || prop.relation !== getPage(tree, row)?.parent || !prop.twoWay);
    setProp(tree, row, prop.id, after, by);
    if (!prop.twoWay || !prop.backProp) return;
    for (const target of after) {
      if (before.has(target)) continue;
      const list = asStrings(getPage(tree, target)?.props[prop.backProp]);
      if (!list.includes(row)) setProp(tree, target, prop.backProp, [...list, row], by);
    }
    for (const target of before) {
      if (after.includes(target)) continue;
      const list = asStrings(getPage(tree, target)?.props[prop.backProp]);
      if (list.includes(row)) setProp(tree, target, prop.backProp, list.filter((x) => x !== row), by);
    }
  });
}

export function addRelationProperty(doc: Y.Doc, input: { name?: string; target: PageId; source: PageId; twoWay: boolean; targetDoc?: Y.Doc | null; sourceName?: string }): string {
  const id = newId();
  const back = input.twoWay ? newId() : "";
  addProperty(doc, { type: "relation", name: input.name ?? "Relation", relation: input.target, twoWay: input.twoWay, backProp: back }, { id });
  if (input.twoWay) {
    const targetDoc = input.target === input.source ? doc : input.targetDoc;
    if (targetDoc) addProperty(targetDoc, { type: "relation", name: input.target === input.source ? `Related to ${input.name ?? "Relation"}` : `Related to ${input.sourceName || "Untitled"}`, relation: input.source, twoWay: true, backProp: id }, { id: back });
  }
  return id;
}

export function unlinkBackRelation(targetDoc: Y.Doc, backProp: string) {
  const entry = schemaOf(targetDoc).get(backProp);
  if (!(entry instanceof Y.Map)) return;
  targetDoc.transact(() => {
    entry.set("twoWay", false);
    entry.set("backProp", "");
  });
}

export function syncBackRelation(tree: Y.Doc, database: PageId, prop: Property, by: string) {
  if (!prop.twoWay || !prop.backProp) return;
  tree.transact(() => {
    for (const row of databaseRows(tree, database)) {
      for (const target of idsValue(row, prop)) {
        const list = asStrings(getPage(tree, target)?.props[prop.backProp]);
        if (!list.includes(row.id)) setProp(tree, target, prop.backProp, [...list, row.id], by);
      }
    }
  });
}

export function retypeProperty(doc: Y.Doc, tree: Y.Doc, database: PageId, prop: Property, type: PropType, by: string, ctx?: DbContext) {
  if (prop.id === TITLE || prop.type === type) return;
  const rows = databaseRows(tree, database);
  const old = prop;
  const texts = new Map<string, string[]>();
  for (const row of rows) {
    let parts: string[];
    if (old.type === "select" || old.type === "status") parts = [selectValue(row, old)?.name ?? ""];
    else if (old.type === "multi_select") parts = multiValue(row, old).map((o) => o.name);
    else if (old.type === "checkbox") parts = [checkValue(row, old) ? "Yes" : ""];
    else if (old.type === "date") parts = [formatDate(dateToF(dateValue(row, old)), old)];
    else if (old.type === "person") parts = idsValue(row, old).map((id) => ctx?.people.get(id)?.name ?? "");
    else if (old.type === "number") parts = [numberValue(row, old) === null ? "" : String(numberValue(row, old))];
    else if (old.type === "formula" || old.type === "rollup") parts = ctx ? [fToText(fvalue(ctx, row, old), old)] : [""];
    else {
      const raw = row.props[old.id];
      parts = [typeof raw === "string" ? raw : ""];
    }
    if (old.type === "text" && (type === "multi_select" || type === "person")) parts = parts.flatMap((p) => p.split(",")).map((p) => p.trim());
    texts.set(row.id, parts.filter(Boolean));
  }
  doc.transact(() => {
    updateProperty(doc, prop.id, { type });
  });
  const keepOptions = (old.type === "select" || old.type === "multi_select" || old.type === "status") && (type === "select" || type === "multi_select" || type === "status");
  const optionIds = new Map<string, string>();
  if (type === "select" || type === "multi_select" || type === "status") {
    const current = readSchema(doc).find((p) => p.id === prop.id)!;
    for (const o of current.options) optionIds.set(o.name.toLowerCase(), o.id);
    doc.transact(() => {
      for (const parts of texts.values())
        for (const part of parts) {
          const k = part.toLowerCase();
          if (!optionIds.has(k)) optionIds.set(k, addOption(doc, prop.id, part, type === "status" ? { group: "todo" } : {}));
        }
    });
  }
  tree.transact(() => {
    for (const row of rows) {
      const parts = texts.get(row.id) ?? [];
      let value: unknown = null;
      switch (type) {
        case "text":
        case "url":
        case "email":
        case "phone":
          value = parts.join(", ") || null;
          break;
        case "number": {
          const n = Number((parts[0] ?? "").replace(/[, $€£¥₹%]/g, ""));
          value = parts[0] && Number.isFinite(n) ? n : null;
          break;
        }
        case "select":
        case "status":
          value = keepOptions ? (old.type === "multi_select" ? asStrings(row.props[old.id])[0] ?? null : row.props[old.id] ?? null) : parts[0] ? optionIds.get(parts[0].toLowerCase()) ?? null : null;
          break;
        case "multi_select":
          value = keepOptions ? asStrings(row.props[old.id]) : parts.map((p) => optionIds.get(p.toLowerCase())).filter(Boolean);
          break;
        case "checkbox":
          value = parts.some((p) => !["", "0", "false", "no", "off"].includes(p.toLowerCase()));
          break;
        case "date": {
          const p = parts[0] ? Date.parse(parts[0]) : NaN;
          value = Number.isFinite(p) ? { start: toDateString(p) } : null;
          break;
        }
        default:
          value = row.props[old.id] ?? null;
          if (type === "id" || type === "formula" || type === "rollup" || type === "created_time" || type === "created_by" || type === "edited_time" || type === "edited_by" || type === "person" || type === "relation" || type === "files") value = null;
      }
      const prev = row.props[old.id];
      if (JSON.stringify(prev ?? null) !== JSON.stringify(value ?? null)) setProp(tree, row.id, prop.id, value, by);
    }
    if (type === "id") {
      let n = 1;
      for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) setProp(tree, row.id, prop.id, n++, by);
    }
  });
}

export function duplicateRowProps(row: PageMeta, schema: Property[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schema) if (isEditable(p.type) && p.type !== "title" && row.props[p.id] !== undefined) out[p.id] = row.props[p.id];
  return out;
}

export function statusGroupOf(prop: Property, option: string | undefined): StatusGroup | null {
  return prop.options.find((o) => o.id === option)?.group ?? null;
}
