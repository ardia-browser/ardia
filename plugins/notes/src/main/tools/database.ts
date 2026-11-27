import * as Y from "yjs";
import { archivePage, blocksOf, displayTitle, getPage, movePage, pagesOf, restorePage, setProp, updatePage, type PageMeta } from "../../shared/model";
import {
  CALC_LABELS,
  COLORS,
  DATE_FORMATS,
  FORMULA_FUNCTIONS,
  NUMBER_FORMATS,
  PROP_TYPES,
  RELATIVE_RANGES,
  ROLLUP_LABELS,
  STATUS_GROUPS,
  TITLE,
  VIEW_TYPES,
  addOption,
  addProperty,
  addRelationProperty,
  addView,
  cleanFilter,
  compileFormula,
  computeView,
  condsFor,
  createRow,
  databaseRows,
  deleteOption,
  deleteProperty,
  deleteView,
  duplicateProperty,
  duplicateRowProps,
  duplicateView,
  fvalue,
  initDatabase,
  initLinkedDatabase,
  isEditable,
  isError,
  kindOf,
  makeContext,
  moveOption,
  moveProperty,
  moveView,
  moveViewProp,
  nextIdNumber,
  readPeople,
  readSchema,
  readSettings,
  readViews,
  retypeProperty,
  setCalc,
  setCell,
  setGroupState,
  setRelation,
  setViewProp,
  syncBackRelation,
  unlinkBackRelation,
  updateOption,
  updateProperty,
  updateSettings,
  updateView,
  type CalcFn,
  type DbContext,
  type FValue,
  type FilterGroup,
  type FilterRule,
  type Kind,
  type Property,
  type PropType,
  type View,
  type ViewType,
} from "../../shared/database";
import { buildBlock, cleanBlock, writeDoc } from "./blocks";
import { ensureRoot } from "./editing";
import { markdownToBlocks } from "./markdown";
import { Session, iso, type Found } from "./common";
import { ToolError, any, arr, bool, closest, int, num, oneOf, opt, quoteList, rec, req, str, suggest, type Field } from "./spec";

const PROP_TYPE_IDS = PROP_TYPES.map((p) => p.type);
const VIEW_TYPE_IDS = VIEW_TYPES.map((v) => v.type);
const COLOR_IDS = [...COLORS];
const ROLLUP_FNS = Object.keys(ROLLUP_LABELS);
const CALC_FNS = Object.keys(CALC_LABELS);
const CONDS = ["is", "is_not", "contains", "not_contains", "starts", "ends", "empty", "not_empty", "eq", "neq", "gt", "lt", "gte", "lte", "before", "after", "on_or_before", "on_or_after", "between", "relative", "checked", "unchecked"];

export type Model = {
  found: Found;
  ws: string;
  id: string;
  source: string;
  tree: Y.Doc;
  doc: Y.Doc;
  schemaDoc: Y.Doc;
  schema: Property[];
  views: View[];
  ctx: DbContext;
  rows: PageMeta[];
  templates: PageMeta[];
};

export async function model(s: Session, ref: unknown, field = "database"): Promise<Model> {
  const found = await s.page(ref, { field, kind: "database" });
  return modelOf(s, found);
}

export async function modelOf(s: Session, found: Found): Promise<Model> {
  const ws = found.ws;
  const doc = await s.a.doc(ws, found.meta.id);
  if (!readSettings(doc).source && !doc.getMap("settings").get("initialized") && doc.getArray("views").length === 0 && doc.getMap("viewsById").size === 0) {
    const linked = found.meta.props.linkedSource;
    if (typeof linked === "string" && /^[0-9a-f]{12}$/.test(linked)) {
      const src = await s.a.doc(ws, linked);
      initLinkedDatabase(doc, linked, "table", readSchema(src));
    } else initDatabase(doc, { view: VIEW_TYPE_IDS.includes(found.meta.props.initialView as ViewType) ? (found.meta.props.initialView as ViewType) : "table" });
  }
  const source = readSettings(doc).source || found.meta.id;
  const schemaDoc = source === found.meta.id ? doc : await s.a.doc(ws, source);
  const tree = await s.a.tree(ws);
  const schema = readSchema(schemaDoc);
  const schemas = new Map<string, Property[]>([[source, schema]]);
  for (const p of schema) if (p.type === "relation" && p.relation && !schemas.has(p.relation) && getPage(tree, p.relation)) schemas.set(p.relation, readSchema(await s.a.doc(ws, p.relation)));
  const people = new Map(readPeople(schemaDoc).map((p) => [p.id, p]));
  const me = s.a.me();
  people.set(me.deviceId, { id: me.deviceId, name: me.name, color: me.color });
  const rows = databaseRows(tree, source);
  const ctx = makeContext({
    database: source,
    schema,
    rows,
    page: (id) => getPage(tree, id),
    schemaFor: (id) => schemas.get(id) ?? null,
    rowsFor: (id) => databaseRows(tree, id),
    people,
  });
  return { found, ws, id: found.meta.id, source, tree, doc, schemaDoc, schema, views: readViews(doc), ctx, rows, templates: databaseRows(tree, source, { templates: true }) };
}

function uniqueNames(schema: Property[]) {
  const count = new Map<string, number>();
  for (const p of schema) count.set(p.name.toLowerCase(), (count.get(p.name.toLowerCase()) ?? 0) + 1);
  return (p: Property) => (count.get(p.name.toLowerCase()) === 1 ? p.name : p.id);
}

export function findProp(m: Pick<Model, "schema">, ref: unknown, field = "property"): Property {
  if (typeof ref !== "string" || !ref) throw new ToolError(`${field} must be a property name or id.`);
  const byId = m.schema.find((p) => p.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const byName = m.schema.filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new ToolError(`${byName.length} properties are called '${ref}': ids ${quoteList(byName.map((p) => p.id))}. Pass the id.`);
  throw new ToolError(`unknown property '${ref.slice(0, 60)}'${suggest(ref, m.schema.map((p) => p.name))} Properties: ${quoteList(m.schema.map((p) => p.name))}.`);
}

function findOption(prop: Property, ref: unknown, field: string) {
  if (typeof ref !== "string" || !ref) throw new ToolError(`${field} must be an option name or id.`);
  const hit = prop.options.find((o) => o.id === ref) ?? prop.options.find((o) => o.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit;
  throw new ToolError(`'${prop.name}' has no option '${ref.slice(0, 60)}'${suggest(ref, prop.options.map((o) => o.name))}${prop.options.length ? ` Options: ${quoteList(prop.options.map((o) => o.name))}.` : " It has no options yet."}`);
}

export function propertyJson(m: Pick<Model, "schema" | "tree">, p: Property): Record<string, unknown> {
  const label = uniqueNames(m.schema);
  const out: Record<string, unknown> = { id: p.id, name: p.name, type: p.type };
  if (p.description) out.description = p.description;
  if (p.type === "select" || p.type === "multi_select" || p.type === "status") out.options = p.options.map((o) => ({ id: o.id, name: o.name, color: o.color, ...(o.group ? { group: o.group } : {}) }));
  if (p.type === "number") Object.assign(out, { format: p.format, display: p.display, ...(p.display !== "number" ? { divideBy: p.divideBy, barColor: p.barColor, showNumber: p.showNumber } : {}) });
  if (p.type === "date" || p.type === "created_time" || p.type === "edited_time") Object.assign(out, { dateFormat: p.dateFormat, timeFormat: p.timeFormat });
  if (p.type === "formula") out.expression = p.expression;
  if (p.type === "relation") {
    const target = getPage(m.tree, p.relation);
    Object.assign(out, { relation: p.relation, relationTitle: target ? displayTitle(target) : "", twoWay: p.twoWay, ...(p.backProp ? { backProperty: p.backProp } : {}) });
  }
  if (p.type === "rollup") {
    const via = m.schema.find((x) => x.id === p.rollupRelation);
    Object.assign(out, { rollupRelation: via ? label(via) : p.rollupRelation, rollupTarget: p.rollupTarget, rollupFn: p.rollupFn });
  }
  if (p.type === "id") Object.assign(out, { prefix: p.prefix });
  return out;
}

function dateOut(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const d = v as { start?: string; end?: string };
  return d.start ? { start: d.start, ...(d.end ? { end: d.end } : {}) } : null;
}

function fOut(v: FValue | { error: string }): unknown {
  if (isError(v)) return { error: v.error };
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => fOut(x));
  if (v.t === "date") return { start: new Date(v.start).toISOString(), ...(v.end !== undefined ? { end: new Date(v.end).toISOString() } : {}) };
  if (v.t === "page") return { id: v.id, title: v.title };
  return { id: v.id, name: v.name };
}

export function cellOut(m: Model, row: PageMeta, p: Property): unknown {
  const raw = p.type === "title" ? row.title : row.props[p.id];
  switch (p.type) {
    case "title":
      return row.title;
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof raw === "string" ? raw : null;
    case "number":
    case "id":
      return typeof raw === "number" ? raw : null;
    case "checkbox":
      return raw === true;
    case "select":
    case "status":
      return p.options.find((o) => o.id === raw)?.name ?? null;
    case "multi_select":
      return (Array.isArray(raw) ? raw : []).map((id) => p.options.find((o) => o.id === id)?.name).filter(Boolean);
    case "date":
      return dateOut(raw);
    case "person":
      return (Array.isArray(raw) ? raw : []).map((id) => ({ id, name: m.ctx.people.get(String(id))?.name ?? "Someone" }));
    case "relation":
      return (Array.isArray(raw) ? raw : []).map((id) => getPage(m.tree, String(id))).filter((x): x is PageMeta => !!x && !x.deleted && !x.archivedAt).map((x) => ({ id: x.id, title: displayTitle(x) }));
    case "files":
      return Array.isArray(raw) ? raw : [];
    case "created_time":
      return iso(row.createdAt);
    case "edited_time":
      return iso(row.updatedAt);
    case "created_by":
      return row.createdBy ? { id: row.createdBy, name: m.ctx.people.get(row.createdBy)?.name ?? "Someone" } : null;
    case "edited_by":
      return row.updatedBy ? { id: row.updatedBy, name: m.ctx.people.get(row.updatedBy)?.name ?? "Someone" } : null;
    case "formula":
    case "rollup":
      return fOut(fvalue(m.ctx, row, p));
  }
}

export function rowJson(m: Model, row: PageMeta, options: { keys?: "names" | "ids"; only?: Property[] } = {}) {
  const label = uniqueNames(m.schema);
  const props: Record<string, unknown> = {};
  for (const p of options.only ?? m.schema) {
    if (p.type === "title") continue;
    props[options.keys === "ids" ? p.id : label(p)] = cellOut(m, row, p);
  }
  return { id: row.id, title: row.title, icon: row.icon, address: `ardia://notes/${row.id}`, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), properties: props, ...(row.isTemplate ? { isTemplate: true } : {}) };
}

function personRef(m: Model, v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new ToolError(`${field} must be a person's name or id, or "me".`);
  if (v === "me") return s_me(m);
  if (m.ctx.people.has(v)) return v;
  const hits = [...m.ctx.people.values()].filter((p) => p.name.toLowerCase() === v.toLowerCase());
  if (hits.length === 1) return hits[0]!.id;
  throw new ToolError(`${field}: no one called '${v.slice(0, 60)}' has used this database${suggest(v, [...m.ctx.people.values()].map((p) => p.name))} People: ${quoteList([...m.ctx.people.values()].map((p) => `${p.name} (${p.id})`))}, or "me".`);
}

let meId = "";
const s_me = (m: Model) => meId || [...m.ctx.people.keys()][0] || "";

function rowRef(m: Model, target: string, v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new ToolError(`${field} must be a row id or title.`);
  const rows = databaseRows(m.tree, target);
  if (/^[0-9a-f]{12}$/.test(v)) {
    const page = getPage(m.tree, v);
    if (page && !page.deleted && page.parent === target) return v;
    throw new ToolError(`${field}: ${v} isn't a row of the related database.`);
  }
  const hits = rows.filter((r) => displayTitle(r).toLowerCase() === v.toLowerCase());
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length > 1) throw new ToolError(`${field}: ${hits.length} rows are called '${v}'; pass the id (${quoteList(hits.map((h) => h.id))}).`);
  throw new ToolError(`${field}: no row called '${v.slice(0, 60)}' in the related database${suggest(v, rows.map((r) => displayTitle(r)))}`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function dateIn(v: unknown, field: string) {
  if (v === null) return null;
  const check = (x: unknown, f: string) => {
    if (typeof x !== "string" || !DATE_RE.test(x)) throw new ToolError(`${f} must be a date YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
    return x.length > 16 ? x.slice(0, 16) : x;
  };
  if (typeof v === "string") return { start: check(v, field) };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const d = v as Record<string, unknown>;
    for (const k of Object.keys(d)) if (k !== "start" && k !== "end") throw new ToolError(`unknown field '${k}' in ${field}; a date takes 'start' and 'end'.`);
    return { start: check(d.start, `${field}.start`), ...(d.end !== undefined && d.end !== null ? { end: check(d.end, `${field}.end`) } : {}) };
  }
  throw new ToolError(`${field} must be "YYYY-MM-DD" or {start, end}.`);
}

type Pending = { prop: Property; value: unknown };

function cellIn(m: Model, p: Property, v: unknown, field: string, create: boolean): unknown {
  if (!isEditable(p.type)) throw new ToolError(`${field}: '${p.name}' is a ${p.type} property, which is computed and can't be set.`);
  if (v === null) return null;
  switch (p.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      if (typeof v !== "string" && typeof v !== "number") throw new ToolError(`${field}: '${p.name}' takes text.`);
      if (String(v).length > 20_000) throw new ToolError(`${field}: '${p.name}' takes at most 20000 characters.`);
      if (p.type === "url" && v && !/^(https?|mailto|tel):/i.test(String(v).replace(/[\u0000-\u0020\u007f-\u009f]/g, ""))) throw new ToolError(`${field}: '${p.name}' takes an http, https, mailto or tel address.`);
      return String(v);
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${field}: '${p.name}' takes a number.`);
      return v;
    case "checkbox":
      if (typeof v !== "boolean") throw new ToolError(`${field}: '${p.name}' takes true or false.`);
      return v;
    case "select":
    case "status": {
      if (typeof v !== "string") throw new ToolError(`${field}: '${p.name}' takes an option name.`);
      const hit = p.options.find((o) => o.id === v) ?? p.options.find((o) => o.name.toLowerCase() === v.toLowerCase());
      if (hit) return hit.id;
      if (!create || p.type === "status") findOption(p, v, `${field}`);
      return { newOption: v };
    }
    case "multi_select": {
      const list = typeof v === "string" ? [v] : v;
      if (!Array.isArray(list) || list.length > 100) throw new ToolError(`${field}: '${p.name}' takes a list of option names.`);
      return list.map((x, i) => {
        if (typeof x !== "string" || !x) throw new ToolError(`${field}[${i}] must be an option name.`);
        const hit = p.options.find((o) => o.id === x) ?? p.options.find((o) => o.name.toLowerCase() === x.toLowerCase());
        if (hit) return hit.id;
        if (!create) findOption(p, x, `${field}[${i}]`);
        return { newOption: x };
      });
    }
    case "date":
      return dateIn(v, field);
    case "person": {
      const list = typeof v === "string" ? [v] : v;
      if (!Array.isArray(list) || list.length > 100) throw new ToolError(`${field}: '${p.name}' takes a list of people.`);
      return list.map((x, i) => personRef(m, x, `${field}[${i}]`));
    }
    case "relation": {
      const list = typeof v === "string" ? [v] : v;
      if (!Array.isArray(list) || list.length > 500) throw new ToolError(`${field}: '${p.name}' takes a list of row ids or titles.`);
      return list.map((x, i) => rowRef(m, p.relation, x, `${field}[${i}]`));
    }
    case "files": {
      if (!Array.isArray(v) || v.length > 100) throw new ToolError(`${field}: '${p.name}' takes a list of files {ref, name, type}.`);
      return v.map((f, i) => {
        if (!f || typeof f !== "object" || Array.isArray(f)) throw new ToolError(`${field}[${i}] must be {ref, name, type}.`);
        const r = f as Record<string, unknown>;
        for (const k of Object.keys(r)) if (!["ref", "name", "type"].includes(k)) throw new ToolError(`unknown field '${k}' in ${field}[${i}]; a file takes 'ref', 'name', 'type'.`);
        if (typeof r.ref !== "string" || !(/^file:[0-9a-f]{64}$/.test(r.ref) || /^https?:\/\//.test(r.ref))) throw new ToolError(`${field}[${i}].ref must be file:<sha256> from files upload, or an https:// address.`);
        return { ref: r.ref, name: typeof r.name === "string" ? r.name.slice(0, 255) : "file", type: typeof r.type === "string" ? r.type.slice(0, 100) : "" };
      });
    }
  }
  return v;
}

function cellsIn(m: Model, raw: unknown, field: string, create: boolean): Pending[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${field} must be an object of property name → value.`);
  const out: Pending[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    const p = findProp(m, k, `${field}.${k}`);
    if (seen.has(p.id)) throw new ToolError(`${field} sets '${p.name}' twice.`);
    seen.add(p.id);
    out.push({ prop: p, value: cellIn(m, p, v, `${field}.${k}`, create) });
  }
  return out;
}

function applyCells(m: Model, row: string, cells: Pending[], by: string) {
  for (const { prop, value } of cells) {
    let v = value;
    const materialize = (x: unknown) => (x && typeof x === "object" && "newOption" in (x as Record<string, unknown>) ? ensureOption(m, prop, String((x as { newOption: string }).newOption)) : x);
    if (Array.isArray(v)) v = v.map(materialize);
    else v = materialize(v);
    if (prop.type === "relation") setRelation(m.tree, row, prop, (v as string[] | null) ?? [], by);
    else setCell(m.tree, row, prop, v, by);
  }
}

function ensureOption(m: Model, prop: Property, name: string): string {
  const fresh = readSchema(m.schemaDoc).find((p) => p.id === prop.id);
  const hit = fresh?.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const id = addOption(m.schemaDoc, prop.id, name, prop.type === "status" ? { group: "todo" } : {});
  return id;
}

function filterIn(m: Model, raw: unknown, field: string, depth = 0): FilterGroup {
  if (raw === undefined || raw === null) return { kind: "group", id: "root", op: "and", rules: [] };
  if (Array.isArray(raw)) raw = { op: "and", rules: raw };
  if (!raw || typeof raw !== "object") throw new ToolError(`${field} must be {op: "and"|"or", rules: [...]} or a list of rules.`);
  const g = raw as Record<string, unknown>;
  for (const k of Object.keys(g)) if (!["op", "rules", "kind", "id"].includes(k)) throw new ToolError(`unknown field '${k}' in ${field}${suggest(k, ["op", "rules"])} A filter group takes 'op' and 'rules'.`);
  if (g.op !== undefined && g.op !== "and" && g.op !== "or") throw new ToolError(`${field}.op must be 'and' or 'or'.`);
  if (depth > 3) throw new ToolError(`${field}: filter groups nest at most 3 deep.`);
  const rules = g.rules === undefined ? [] : g.rules;
  if (!Array.isArray(rules) || rules.length > 100) throw new ToolError(`${field}.rules must be a list of at most 100 rules.`);
  return {
    kind: "group",
    id: depth === 0 ? "root" : typeof g.id === "string" ? g.id.slice(0, 40) : `g${Math.random().toString(16).slice(2, 10)}`,
    op: g.op === "or" ? "or" : "and",
    rules: rules.map((r, i) => {
      const p = `${field}.rules[${i}]`;
      if (r && typeof r === "object" && !Array.isArray(r) && ("rules" in r || (r as Record<string, unknown>).kind === "group")) return filterIn(m, r, p, depth + 1);
      return ruleIn(m, r, p);
    }),
  };
}

function ruleIn(m: Model, raw: unknown, field: string): FilterRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${field} must be {prop, cond, value}.`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["prop", "property", "cond", "value", "kind", "id"].includes(k)) throw new ToolError(`unknown field '${k}' in ${field}${suggest(k, ["prop", "cond", "value"])} A rule takes 'prop', 'cond', 'value'.`);
  const prop = findProp(m, r.prop ?? r.property, `${field}.prop`);
  const kind = kindOf(m.ctx, prop);
  const conds = condsFor(kind).map((c) => c.id);
  if (typeof r.cond !== "string" || !conds.includes(r.cond as never)) throw new ToolError(`${field}.cond for '${prop.name}' (${kind}) must be one of ${quoteList(conds)}${typeof r.cond === "string" ? suggest(r.cond, conds) : ""}`);
  const cond = r.cond as FilterRule["cond"];
  let value = r.value;
  if (cond === "empty" || cond === "not_empty" || cond === "checked" || cond === "unchecked") value = undefined;
  else if (value === undefined) throw new ToolError(`${field}.value is required for '${cond}'.`);
  else value = filterValue(m, prop, kind, cond, value, `${field}.value`);
  return { kind: "rule", id: typeof r.id === "string" ? r.id.slice(0, 40) : Math.random().toString(16).slice(2, 14), prop: prop.id, cond, ...(value !== undefined ? { value } : {}) };
}

function filterValue(m: Model, prop: Property, kind: Kind, cond: string, value: unknown, field: string): unknown {
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]);
  if (kind === "select" && (prop.type === "select" || prop.type === "status")) return list(value).map((x, i) => findOption(prop, x, `${field}[${i}]`).id);
  if (kind === "multi" && prop.type === "multi_select") return list(value).map((x, i) => findOption(prop, x, `${field}[${i}]`).id);
  if (kind === "person" && (prop.type === "person" || prop.type === "created_by" || prop.type === "edited_by")) return list(value).map((x, i) => personRef(m, x, `${field}[${i}]`));
  if (kind === "relation" && prop.type === "relation") return list(value).map((x, i) => rowRef(m, prop.relation, x, `${field}[${i}]`));
  if (kind === "number") {
    if (typeof value !== "number") throw new ToolError(`${field} must be a number for '${prop.name}'.`);
    return value;
  }
  if (kind === "date") {
    const one = (v: unknown, f: string) => {
      if (typeof v === "string") return dateIn(v, f)!.start;
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).relative === "string") {
        const rel = (v as Record<string, unknown>).relative as string;
        if (!RELATIVE_RANGES.some((x) => x.id === rel)) throw new ToolError(`${f}.relative must be one of ${quoteList(RELATIVE_RANGES.map((x) => x.id))}.`);
        return { relative: rel };
      }
      throw new ToolError(`${f} must be "YYYY-MM-DD" or {relative: "this_week" …}.`);
    };
    if (cond === "between") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError(`${field} must be {start, end} for between.`);
      const v = value as Record<string, unknown>;
      return { start: one(v.start, `${field}.start`), end: one(v.end, `${field}.end`) };
    }
    if (cond === "relative") {
      if (typeof value === "string") return one({ relative: value }, field);
      return one(value, field);
    }
    return one(value, field);
  }
  if (kind === "checkbox") return value === true;
  if (typeof value !== "string") throw new ToolError(`${field} must be text for '${prop.name}'.`);
  return value;
}

function filterOut(m: Model, g: FilterGroup): Record<string, unknown> {
  const label = uniqueNames(m.schema);
  return {
    op: g.op,
    rules: g.rules.map((r) => {
      if (r.kind === "group") return filterOut(m, r);
      const prop = m.schema.find((p) => p.id === r.prop);
      let value = r.value;
      if (prop && (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") && Array.isArray(value)) value = value.map((id) => prop.options.find((o) => o.id === id)?.name ?? id);
      return { prop: prop ? label(prop) : r.prop, cond: r.cond, ...(value !== undefined ? { value } : {}) };
    }),
  };
}

export function viewJson(m: Model, v: View): Record<string, unknown> {
  const label = uniqueNames(m.schema);
  const name = (id: string) => {
    const p = m.schema.find((x) => x.id === id);
    return p ? label(p) : id;
  };
  const props: Record<string, unknown> = {};
  for (const p of m.schema) {
    const vp = v.props[p.id];
    props[label(p)] = { visible: p.id === TITLE ? true : vp?.visible ?? v.type === "table", ...(vp?.width ? { width: vp.width } : {}) };
  }
  const group = (g: View["groupBy"]) => (g ? { ...g, prop: name(g.prop) } : null);
  const out: Record<string, unknown> = {
    id: v.id,
    name: v.name,
    type: v.type,
    filter: filterOut(m, v.filter),
    sorts: v.sorts.map((s) => ({ prop: name(s.prop), dir: s.dir })),
    groupBy: group(v.groupBy),
    subGroupBy: group(v.subGroupBy),
    properties: props,
    order: viewOrder(m, v),
    calculations: Object.fromEntries(Object.entries(v.calcs).map(([k, fn]) => [name(k), fn])),
    groups: v.groups,
    wrap: v.wrap,
    frozen: v.frozen,
    limit: v.limit,
    showIcons: v.showIcons,
    lineNumbers: v.lineNumbers,
  };
  if (v.type === "board" || v.type === "gallery") Object.assign(out, { cardPreview: v.cardPreview, cardSize: v.cardSize, fitImage: v.fitImage, colorColumns: v.colorColumns });
  if (v.type === "calendar" || v.type === "timeline") Object.assign(out, { dateProp: v.dateProp ? name(v.dateProp) : "", endProp: v.endProp ? name(v.endProp) : "", zoom: v.zoom, showTable: v.showTable, showWeekends: v.showWeekends });
  if (v.type === "chart") Object.assign(out, { chartType: v.chartType, chartBy: v.chartBy ? name(v.chartBy) : "", chartAgg: v.chartAgg, chartValue: v.chartValue ? name(v.chartValue) : "" });
  return out;
}

function viewOrder(m: Model, v: View): string[] {
  const label = uniqueNames(m.schema);
  const keyed = m.schema.map((p, i) => ({ p, key: v.props[p.id]?.order || "~", i }));
  const titleFirst = v.type !== "board" && v.type !== "gallery";
  keyed.sort((a, b) => {
    if (titleFirst && a.p.id === TITLE) return -1;
    if (titleFirst && b.p.id === TITLE) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i;
  });
  return keyed.map((x) => label(x.p));
}

const groupBySpec = any("{prop, date?: relative|day|week|month|year, text?: exact|alpha, status?: option|group, step?, sort?: manual|asc|desc, hideEmpty?} or null");

export const VIEW_FIELDS: Record<string, Field> = {
  name: opt(str(200)),
  type: opt(oneOf(VIEW_TYPE_IDS)),
  filter: opt(any("{op: and|or, rules: [{prop, cond, value} | nested group]} or a list of rules; values use option names, person names, row titles, dates YYYY-MM-DD or {relative}")),
  sorts: opt(arr(any("{prop, dir: asc|desc}"), 20)),
  groupBy: opt(groupBySpec),
  subGroupBy: opt(groupBySpec),
  properties: opt(rec(any("{visible?: boolean, width?: pixels}"), 200, "property"), "per property: visible and width"),
  order: opt(arr(str(200), 200), "property names in column order"),
  calculations: opt(rec(oneOf(CALC_FNS), 200, "property"), "footer calculation per property"),
  groups: opt(rec(any("{hidden?: boolean, collapsed?: boolean}"), 500, "group key"), "board/table group state by group key"),
  wrap: opt(bool, "wrap cell text"),
  frozen: opt(int(0, 20), "frozen columns in a table"),
  limit: opt(int(1, 1000), "rows shown before Load more"),
  cardPreview: opt(str(64), "board/gallery: none, cover, content, or a files property"),
  cardSize: opt(oneOf(["small", "medium", "large"])),
  fitImage: opt(bool),
  colorColumns: opt(bool, "board: tint columns"),
  dateProp: opt(str(200), "calendar/timeline: the date property"),
  endProp: opt(str(200), "timeline: an end date property"),
  zoom: opt(oneOf(["day", "week", "month", "quarter", "year"]), "timeline zoom"),
  showTable: opt(bool, "timeline: show the table beside it"),
  showWeekends: opt(bool, "calendar"),
  chartType: opt(oneOf(["bar", "line", "donut"])),
  chartBy: opt(str(200), "chart: group by this property"),
  chartAgg: opt(oneOf(["count", "sum", "avg"])),
  chartValue: opt(str(200), "chart: the number property for sum/avg"),
  showIcons: opt(bool),
  lineNumbers: opt(bool),
};

function groupByIn(m: Model, raw: unknown, field: string): View["groupBy"] {
  if (raw === null) return null;
  if (typeof raw === "string") raw = { prop: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${field} must be {prop, …} or null.`);
  const g = raw as Record<string, unknown>;
  const keys = ["prop", "property", "date", "text", "status", "step", "sort", "hideEmpty"];
  for (const k of Object.keys(g)) if (!keys.includes(k)) throw new ToolError(`unknown field '${k}' in ${field}${suggest(k, keys)}`);
  const prop = findProp(m, g.prop ?? g.property, `${field}.prop`);
  const pick = <T extends string>(k: string, values: readonly T[], d: T): T => {
    if (g[k] === undefined) return d;
    if (!values.includes(g[k] as T)) throw new ToolError(`${field}.${k} must be one of ${quoteList(values)}.`);
    return g[k] as T;
  };
  if (g.step !== undefined && (typeof g.step !== "number" || g.step <= 0)) throw new ToolError(`${field}.step must be a positive number.`);
  if (g.hideEmpty !== undefined && typeof g.hideEmpty !== "boolean") throw new ToolError(`${field}.hideEmpty must be true or false.`);
  return { prop: prop.id, date: pick("date", ["relative", "day", "week", "month", "year"], "relative"), text: pick("text", ["exact", "alpha"], "exact"), status: pick("status", ["option", "group"], "option"), step: (g.step as number) ?? 10, sort: pick("sort", ["manual", "asc", "desc"], "manual"), hideEmpty: g.hideEmpty === true };
}

function applyView(m: Model, id: string, args: Record<string, unknown>, field: string) {
  const patch: Record<string, unknown> = {};
  const propOf = (ref: unknown, f: string) => findProp(m, ref, f);
  for (const k of ["name", "type", "wrap", "frozen", "limit", "cardSize", "fitImage", "colorColumns", "zoom", "showTable", "showWeekends", "chartType", "chartAgg", "showIcons", "lineNumbers"]) if (args[k] !== undefined) patch[k] = args[k];
  if (args.filter !== undefined) patch.filter = cleanFilter(filterIn(m, args.filter, `${field}.filter`));
  if (args.sorts !== undefined)
    patch.sorts = (args.sorts as unknown[]).map((raw, i) => {
      const f = `${field}.sorts[${i}]`;
      if (typeof raw === "string") return { id: `s${i}`, prop: propOf(raw, f).id, dir: "asc" };
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${f} must be {prop, dir}.`);
      const r = raw as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!["prop", "property", "dir", "direction", "id"].includes(k)) throw new ToolError(`unknown field '${k}' in ${f}${suggest(k, ["prop", "dir"])}`);
      const dir = r.dir ?? r.direction ?? "asc";
      if (dir !== "asc" && dir !== "desc") throw new ToolError(`${f}.dir must be 'asc' or 'desc'.`);
      return { id: `s${i}${Math.random().toString(16).slice(2, 8)}`, prop: propOf(r.prop ?? r.property, `${f}.prop`).id, dir };
    });
  if (args.groupBy !== undefined) patch.groupBy = groupByIn(m, args.groupBy, `${field}.groupBy`);
  if (args.subGroupBy !== undefined) patch.subGroupBy = groupByIn(m, args.subGroupBy, `${field}.subGroupBy`);
  for (const k of ["dateProp", "endProp", "chartBy", "chartValue"]) if (args[k] !== undefined) patch[k] = args[k] === "" ? "" : propOf(args[k], `${field}.${k}`).id;
  if (args.cardPreview !== undefined) {
    const v = String(args.cardPreview);
    patch.cardPreview = ["none", "cover", "content"].includes(v) ? v : propOf(v, `${field}.cardPreview`).id;
  }
  if (Object.keys(patch).length) updateView(m.doc, id, patch as never);
  if (args.properties !== undefined)
    for (const [ref, raw] of Object.entries(args.properties as Record<string, unknown>)) {
      const f = `${field}.properties.${ref}`;
      const p = propOf(ref, f);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${f} must be {visible?, width?}.`);
      const r = raw as Record<string, unknown>;
      for (const k of Object.keys(r)) if (k !== "visible" && k !== "width") throw new ToolError(`unknown field '${k}' in ${f}${suggest(k, ["visible", "width"])}`);
      if (r.visible !== undefined && typeof r.visible !== "boolean") throw new ToolError(`${f}.visible must be true or false.`);
      if (r.width !== undefined && (typeof r.width !== "number" || r.width < 40 || r.width > 2000)) throw new ToolError(`${f}.width must be 40 to 2000 pixels.`);
      setViewProp(m.doc, id, p.id, { ...(r.visible !== undefined ? { visible: r.visible as boolean } : {}), ...(r.width !== undefined ? { width: r.width as number } : {}) });
    }
  if (args.order !== undefined) {
    const ids = (args.order as string[]).map((ref, i) => propOf(ref, `${field}.order[${i}]`).id);
    let after: string | null = null;
    for (const pid of ids) {
      const view = readViews(m.doc).find((x) => x.id === id)!;
      moveViewProp(m.doc, view, m.schema, pid, after);
      after = pid;
    }
  }
  if (args.calculations !== undefined) for (const [ref, fn] of Object.entries(args.calculations as Record<string, string>)) setCalc(m.doc, id, propOf(ref, `${field}.calculations.${ref}`).id, fn as CalcFn);
  if (args.groups !== undefined)
    for (const [key, raw] of Object.entries(args.groups as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${field}.groups.${key} must be {hidden?, collapsed?}.`);
      const r = raw as Record<string, unknown>;
      for (const k of Object.keys(r)) if (k !== "hidden" && k !== "collapsed") throw new ToolError(`unknown field '${k}' in ${field}.groups.${key}`);
      setGroupState(m.doc, id, key, { ...(typeof r.hidden === "boolean" ? { hidden: r.hidden } : {}), ...(typeof r.collapsed === "boolean" ? { collapsed: r.collapsed } : {}) });
    }
}

function findView(m: Model, ref: unknown, field = "view"): View {
  if (typeof ref !== "string" || !ref) throw new ToolError(`${field} must be a view id or name.`);
  const hit = m.views.find((v) => v.id === ref) ?? m.views.find((v) => v.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit;
  throw new ToolError(`'${displayTitle(m.found.meta)}' has no view '${ref.slice(0, 60)}'${suggest(ref, m.views.map((v) => v.name))} Views: ${quoteList(m.views.map((v) => `${v.name} (${v.id})`))}.`);
}

export const PROPERTY_FIELDS: Record<string, Field> = {
  name: opt(str(200)),
  type: opt(oneOf(PROP_TYPE_IDS)),
  description: opt(str(2000)),
  options: opt(arr(any("{name, color?, group?: todo|doing|done}"), 200), "select, multi_select, status: the options in order"),
  format: opt(oneOf(NUMBER_FORMATS.map((f) => f.id)), "number format"),
  display: opt(oneOf(["number", "bar", "ring"]), "number display"),
  divideBy: opt(num(0.000001, 1e12), "bar/ring: the value that fills it"),
  barColor: opt(oneOf(COLOR_IDS)),
  showNumber: opt(bool),
  dateFormat: opt(oneOf(DATE_FORMATS.map((f) => f.id))),
  timeFormat: opt(oneOf(["12", "24", "hidden"])),
  expression: opt(str(4000), "formula: e.g. prop(\"Price\") * prop(\"Qty\")"),
  relation: opt(str(4096), "relation: the target database (id or title)"),
  twoWay: opt(bool, "relation: also add a property on the target that shows the link back"),
  relatedName: opt(str(200), "relation with twoWay: name of the property on the target"),
  rollupRelation: opt(str(200), "rollup: the relation property to follow"),
  rollupTarget: opt(str(200), "rollup: the property of the related rows"),
  rollupFn: opt(oneOf(ROLLUP_FNS), "rollup: how to combine"),
  prefix: opt(str(20), "id: text before the number"),
};

function cleanOptionsIn(raw: unknown, field: string, status: boolean) {
  return (raw as unknown[]).map((o, i) => {
    const f = `${field}[${i}]`;
    if (typeof o === "string") return { name: o, color: "default" as const, ...(status ? { group: "todo" as const } : {}) };
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new ToolError(`${f} must be an option name or {name, color, group}.`);
    const r = o as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!["name", "color", "group", "id"].includes(k)) throw new ToolError(`unknown field '${k}' in ${f}${suggest(k, ["name", "color", "group"])}`);
    if (typeof r.name !== "string" || !r.name || r.name.length > 200) throw new ToolError(`${f}.name must be 1 to 200 characters.`);
    if (r.color !== undefined && !COLOR_IDS.includes(r.color as never)) throw new ToolError(`${f}.color must be one of ${quoteList(COLOR_IDS)}${typeof r.color === "string" ? suggest(r.color, COLOR_IDS) : ""}`);
    if (r.group !== undefined && !["todo", "doing", "done"].includes(r.group as string)) throw new ToolError(`${f}.group must be 'todo', 'doing' or 'done'.`);
    if (r.group !== undefined && !status) throw new ToolError(`${f}.group is only for status properties.`);
    return { name: r.name, color: (r.color ?? "default") as (typeof COLORS)[number], ...(status ? { group: (r.group ?? "todo") as "todo" | "doing" | "done" } : {}) };
  });
}

async function targetDatabase(s: Session, m: Model, ref: unknown, field: string) {
  const found = await s.page(ref, { field, kind: "database", workspace: m.ws });
  const doc = await s.a.doc(found.ws, found.meta.id);
  const source = readSettings(doc).source;
  if (source) throw new ToolError(`${field}: '${displayTitle(found.meta)}' is a linked view of another database; relate to the original (${source}).`);
  return { found, doc };
}

function propertyConfig(m: Model, p: Property | null, type: PropType, args: Record<string, unknown>, field: string): Partial<Property> {
  const patch: Partial<Property> = {};
  const allowed: Record<string, PropType[]> = {
    format: ["number"],
    display: ["number"],
    divideBy: ["number"],
    barColor: ["number"],
    showNumber: ["number"],
    dateFormat: ["date", "created_time", "edited_time"],
    timeFormat: ["date", "created_time", "edited_time"],
    expression: ["formula"],
    rollupRelation: ["rollup"],
    rollupTarget: ["rollup"],
    rollupFn: ["rollup"],
    prefix: ["id"],
    options: ["select", "multi_select", "status"],
    relation: ["relation"],
    twoWay: ["relation"],
    relatedName: ["relation"],
  };
  for (const [k, types] of Object.entries(allowed)) if (args[k] !== undefined && !types.includes(type)) throw new ToolError(`${field}.${k} is for ${types.join("/")} properties, not ${type}.`);
  for (const k of ["description", "format", "display", "divideBy", "barColor", "showNumber", "dateFormat", "timeFormat", "prefix"] as const) if (args[k] !== undefined) (patch as Record<string, unknown>)[k] = args[k];
  if (args.expression !== undefined) {
    const compiled = compileFormula(String(args.expression));
    if ("error" in compiled && !("k" in compiled)) throw new ToolError(`${field}.expression doesn't parse: ${(compiled as { error: string }).error}. Functions: ${FORMULA_FUNCTIONS.join(", ")}; refer to properties with prop("Name").`);
    patch.expression = String(args.expression);
  }
  if (args.rollupRelation !== undefined) {
    const via = findProp(m, args.rollupRelation, `${field}.rollupRelation`);
    if (via.type !== "relation") throw new ToolError(`${field}.rollupRelation '${via.name}' is a ${via.type}; it must be a relation property.`);
    patch.rollupRelation = via.id;
  }
  const relationId = patch.rollupRelation ?? p?.rollupRelation;
  if (args.rollupTarget !== undefined) {
    const via = m.schema.find((x) => x.id === relationId);
    if (!via) throw new ToolError(`${field}.rollupTarget needs rollupRelation first.`);
    const schema = m.ctx.schemaFor(via.relation);
    if (!schema) throw new ToolError(`${field}: the related database isn't readable.`);
    patch.rollupTarget = findProp({ schema }, args.rollupTarget, `${field}.rollupTarget`).id;
  }
  if (args.rollupFn !== undefined) patch.rollupFn = args.rollupFn as Property["rollupFn"];
  return patch;
}

export function databaseTools(s: Session) {
  const by = () => s.a.deviceId();
  meId = s.a.deviceId();
  const commit = async (m: Model, extra: string[] = []) => s.saved(m.ws, [m.id, ...(m.source !== m.id ? [m.source] : []), ...extra]);
  const edit = <T>(ref: unknown, task: (m: Model) => Promise<T> | T, field = "database") =>
    (async () => {
      const first = await model(s, ref, field);
      return s.a.edit([first.ws], async () => {
        const m = await modelOf(s, first.found);
        meId = s.a.deviceId();
        const value = await task(m);
        return value;
      });
    })();

  const database = {
    get: async (args: Record<string, unknown>) => {
      const m = await model(s, args.database);
      const settings = readSettings(m.doc);
      return {
        database: s.pageJson(m.found),
        source: m.source,
        linked: m.source !== m.id,
        settings: { description: settings.description, showDescription: settings.showDescription, openAs: settings.openAs, locked: settings.locked, defaultTemplate: settings.defaultTemplate },
        properties: m.schema.map((p) => propertyJson(m, p)),
        views: m.views.map((v) => viewJson(m, v)),
        rowCount: m.rows.length,
        templates: m.templates.map((t) => ({ id: t.id, title: t.title })),
      };
    },
    list: async (args: Record<string, unknown>) => {
      const ws = await s.workspace(args.workspace);
      const tree = await s.a.tree(ws);
      const out: Record<string, unknown>[] = [];
      for (const p of pagesOf(tree).keys()) {
        const meta = getPage(tree, p);
        if (!meta || meta.deleted || meta.kind !== "database") continue;
        out.push({ id: meta.id, title: displayTitle(meta), parent: meta.parent, inline: meta.props.inline === true, archived: meta.archivedAt > 0, rows: databaseRows(tree, meta.id).length });
      }
      return { workspace: ws, databases: out };
    },
    create: async (args: Record<string, unknown>) => {
      const ws = args.parent ? (await s.page(args.parent, { field: "parent", workspace: args.workspace })).ws : await s.workspace(args.workspace);
      const parent = args.parent ? (await s.page(args.parent, { field: "parent", workspace: ws })).meta : null;
      if (args.inline && (!parent || parent.kind !== "page")) throw new ToolError("database create: inline needs a parent page to sit in.");
      const view = (args.view as ViewType) ?? "table";
      return s.a.edit([ws], async () => {
        const { page } = (await s.a.run("createPage", { workspace: ws, parent: parent?.id ?? "", kind: "database", ...(args.title !== undefined ? { title: args.title } : {}), ...(args.icon !== undefined ? { icon: args.icon } : {}), props: { initialView: view, inline: args.inline === true } })) as { page: string };
        const doc = await s.a.doc(ws, page);
        initDatabase(doc, { view });
        if (args.description !== undefined) updateSettings(doc, { description: String(args.description) });
        if (args.properties !== undefined) deleteProperty(doc, "tags");
        const found = await s.page(page, { workspace: ws });
        const m = await modelOf(s, found);
        for (const [i, raw] of ((args.properties as unknown[]) ?? []).entries()) await addPropertyFrom(s, m, raw as Record<string, unknown>, `properties[${i}]`);
        if (args.inline && parent) {
          const pdoc = await s.a.doc(ws, parent.id);
          await s.a.beforeEdit(ws, parent.id, pdoc);
          pdoc.transact(() => ensureRoot(blocksOf(pdoc)).push([buildBlock(cleanBlock({ type: "database", props: { workspace: ws, database: page, view: "" } }, "block"))]));
        }
        const saved = await s.saved(ws, [page, ...(parent ? [parent.id] : [])]);
        return { ...(await database.get({ database: page })), saved };
      });
    },
    link: async (args: Record<string, unknown>) => {
      const source = await s.page(args.source, { field: "source", kind: "database" });
      const parent = await s.page(args.parent, { field: "parent", workspace: source.ws });
      if (parent.meta.kind !== "page") throw new ToolError("database link: parent must be a page.");
      const sdoc = await s.a.doc(source.ws, source.meta.id);
      const original = readSettings(sdoc).source || source.meta.id;
      return s.a.edit([source.ws], async () => {
        const { page } = (await s.a.run("createPage", { workspace: source.ws, parent: parent.meta.id, kind: "database", props: { linkedSource: original, inline: true } })) as { page: string };
        const doc = await s.a.doc(source.ws, page);
        const view = (args.view as ViewType) ?? "table";
        const odoc = await s.a.doc(source.ws, original);
        initLinkedDatabase(doc, original, view, readSchema(odoc));
        const pdoc = await s.a.doc(source.ws, parent.meta.id);
        await s.a.beforeEdit(source.ws, parent.meta.id, pdoc);
        pdoc.transact(() => ensureRoot(blocksOf(pdoc)).push([buildBlock(cleanBlock({ type: "database", props: { workspace: source.ws, database: page, view: "" } }, "block"))]));
        const saved = await s.saved(source.ws, [page, parent.meta.id]);
        return { ...(await database.get({ database: page })), saved };
      });
    },
    update: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const patch: Record<string, unknown> = {};
        for (const k of ["description", "showDescription", "openAs", "locked"]) if (args[k] !== undefined) patch[k] = args[k];
        if (args.defaultTemplate !== undefined) {
          if (args.defaultTemplate === "" || args.defaultTemplate === null) patch.defaultTemplate = "";
          else {
            const t = m.templates.find((x) => x.id === args.defaultTemplate || x.title.toLowerCase() === String(args.defaultTemplate).toLowerCase());
            if (!t) throw new ToolError(`database update: no template '${String(args.defaultTemplate)}' in this database${suggest(String(args.defaultTemplate), m.templates.map((x) => x.title))}`);
            patch.defaultTemplate = t.id;
          }
        }
        if (Object.keys(patch).length) updateSettings(m.doc, patch as never);
        if (args.title !== undefined || args.icon !== undefined) updatePage(m.tree, m.id, { ...(args.title !== undefined ? { title: String(args.title) } : {}), ...(args.icon !== undefined ? { icon: String(args.icon) } : {}) }, by());
        const saved = await commit(m);
        return { ...(await database.get({ database: m.id })), saved };
      }),
  };

  const properties = {
    list: async (args: Record<string, unknown>) => {
      const m = await model(s, args.database);
      return { database: m.id, properties: m.schema.map((p) => propertyJson(m, p)) };
    },
    add: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const { database: _d, ...rest } = args;
        const id = await addPropertyFrom(s, m, rest, "properties add");
        const saved = await commit(m, relationTargets(m, id));
        const fresh = await model(s, m.id);
        return { property: propertyJson(fresh, findProp(fresh, id)), saved };
      }),
    update: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        if (args.type !== undefined && args.type !== p.type) {
          if (p.id === TITLE) throw new ToolError("properties update: the title property can't change type.");
          retypeProperty(m.schemaDoc, m.tree, m.source, p, args.type as PropType, by(), m.ctx);
          if (args.type === "relation") updateProperty(m.schemaDoc, p.id, { relation: m.source });
        }
        const type = (args.type as PropType) ?? p.type;
        const fresh = await modelOf(s, m.found);
        const now = findProp(fresh, p.id);
        const patch = propertyConfig(fresh, now, type, args, "properties update");
        if (args.name !== undefined) patch.name = String(args.name).slice(0, 200);
        if (args.relation !== undefined) {
          const target = await targetDatabase(s, fresh, args.relation, "properties update.relation");
          patch.relation = target.found.meta.id;
        }
        if (args.twoWay !== undefined && type === "relation") {
          if (args.twoWay && !now.twoWay) {
            const target = await targetDatabase(s, fresh, patch.relation ?? now.relation, "properties update.relation");
            const back = addProperty(target.doc, { type: "relation", name: String(args.relatedName ?? `Related to ${displayTitle(m.found.meta)}`), relation: m.source, twoWay: true, backProp: p.id });
            patch.twoWay = true;
            patch.backProp = back;
          } else if (!args.twoWay && now.twoWay && now.backProp) {
            const target = await s.a.doc(m.ws, now.relation);
            unlinkBackRelation(target, now.backProp);
            patch.twoWay = false;
            patch.backProp = "";
          }
        }
        if (Object.keys(patch).length) updateProperty(m.schemaDoc, p.id, patch);
        if (args.options !== undefined) {
          const list = cleanOptionsIn(args.options, "properties update.options", type === "status");
          const current = readSchema(m.schemaDoc).find((x) => x.id === p.id)!;
          m.schemaDoc.transact(() => {
            const keep = new Set<string>();
            let after: string | null = null;
            for (const o of list) {
              const hit = current.options.find((x) => x.name.toLowerCase() === o.name.toLowerCase() && !keep.has(x.id));
              const id = hit ? hit.id : addOption(m.schemaDoc, p.id, o.name, { color: o.color, ...(o.group ? { group: o.group } : {}) });
              if (hit) updateOption(m.schemaDoc, p.id, id, { name: o.name, color: o.color, ...(o.group ? { group: o.group } : {}) });
              keep.add(id);
              moveOption(m.schemaDoc, p.id, id, after);
              after = id;
            }
            for (const o of current.options) if (!keep.has(o.id)) deleteOption(m.schemaDoc, p.id, o.id);
          });
        }
        if (type === "relation" && (patch.twoWay || args.relation !== undefined)) {
          const prop = readSchema(m.schemaDoc).find((x) => x.id === p.id)!;
          if (prop.twoWay) {
            syncBackRelation(m.tree, m.source, prop, by());
          }
        }
        const saved = await commit(m, relationTargets(await modelOf(s, m.found), p.id));
        const after = await model(s, m.id);
        return { property: propertyJson(after, findProp(after, p.id)), saved };
      }),
    delete: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        if (p.id === TITLE) throw new ToolError("properties delete: the title property can't be deleted.");
        if (p.type === "relation" && p.twoWay && p.backProp) unlinkBackRelation(await s.a.doc(m.ws, p.relation), p.backProp);
        deleteProperty(m.schemaDoc, p.id);
        return { deleted: { id: p.id, name: p.name }, saved: await commit(m, p.type === "relation" ? [p.relation] : []) };
      }),
    move: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        const after = args.after === null || args.after === undefined ? null : findProp(m, args.after, "after").id;
        moveProperty(m.schemaDoc, p.id, after);
        const fresh = await modelOf(s, m.found);
        return { properties: fresh.schema.map((x) => x.name), saved: await commit(m) };
      }),
    duplicate: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        const id = duplicateProperty(m.schemaDoc, p.id);
        if (!id) throw new ToolError("properties duplicate: the title property can't be duplicated.");
        const fresh = await modelOf(s, m.found);
        return { property: propertyJson(fresh, findProp(fresh, id)), saved: await commit(m) };
      }),
    option_add: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        if (!["select", "multi_select", "status"].includes(p.type)) throw new ToolError(`'${p.name}' is a ${p.type}; options are for select, multi_select and status.`);
        const [o] = cleanOptionsIn([{ name: args.name, ...(args.color ? { color: args.color } : {}), ...(args.group ? { group: args.group } : {}) }], "option", p.type === "status");
        if (p.options.some((x) => x.name.toLowerCase() === o!.name.toLowerCase())) throw new ToolError(`'${p.name}' already has an option '${o!.name}'.`);
        const id = addOption(m.schemaDoc, p.id, o!.name, { ...(args.color ? { color: o!.color } : {}), ...(o!.group ? { group: o!.group } : {}) });
        const fresh = await modelOf(s, m.found);
        return { property: propertyJson(fresh, findProp(fresh, p.id)), option: id, saved: await commit(m) };
      }),
    option_update: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        const o = findOption(p, args.option, "option");
        if (args.color !== undefined && !COLOR_IDS.includes(args.color as never)) throw new ToolError(`color must be one of ${quoteList(COLOR_IDS)}.`);
        if (args.group !== undefined && p.type !== "status") throw new ToolError("group is only for status options.");
        updateOption(m.schemaDoc, p.id, o.id, { ...(args.name !== undefined ? { name: String(args.name) } : {}), ...(args.color !== undefined ? { color: args.color as never } : {}), ...(args.group !== undefined ? { group: args.group as never } : {}) });
        const fresh = await modelOf(s, m.found);
        return { property: propertyJson(fresh, findProp(fresh, p.id)), saved: await commit(m) };
      }),
    option_delete: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        const o = findOption(p, args.option, "option");
        deleteOption(m.schemaDoc, p.id, o.id);
        const fresh = await modelOf(s, m.found);
        return { property: propertyJson(fresh, findProp(fresh, p.id)), saved: await commit(m) };
      }),
    option_move: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const p = findProp(m, args.property);
        const o = findOption(p, args.option, "option");
        const after = args.after === null || args.after === undefined ? null : findOption(p, args.after, "after").id;
        moveOption(m.schemaDoc, p.id, o.id, after, args.group as never);
        const fresh = await modelOf(s, m.found);
        return { property: propertyJson(fresh, findProp(fresh, p.id)), saved: await commit(m) };
      }),
  };

  const views = {
    list: async (args: Record<string, unknown>) => {
      const m = await model(s, args.database);
      return { database: m.id, views: m.views.map((v) => viewJson(m, v)) };
    },
    get: async (args: Record<string, unknown>) => {
      const m = await model(s, args.database);
      return { database: m.id, view: viewJson(m, findView(m, args.view)) };
    },
    add: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const type = (args.type as ViewType) ?? "table";
        const after = args.after ? findView(m, args.after, "after").id : undefined;
        const id = addView(m.doc, type, { ...(args.name !== undefined ? { name: String(args.name) } : {}), ...(after ? { after } : {}) });
        const { database: _d, after: _a, ...rest } = args;
        applyView({ ...m, views: readViews(m.doc) }, id, rest, "views add");
        const fresh = await modelOf(s, m.found);
        return { view: viewJson(fresh, findView(fresh, id)), saved: await commit(m) };
      }),
    update: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const v = findView(m, args.view);
        const { database: _d, view: _v, ...rest } = args;
        applyView(m, v.id, rest, "views update");
        const fresh = await modelOf(s, m.found);
        return { view: viewJson(fresh, findView(fresh, v.id)), saved: await commit(m) };
      }),
    delete: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const v = findView(m, args.view);
        if (m.views.length <= 1) throw new ToolError("views delete: a database keeps at least one view.");
        deleteView(m.doc, v.id);
        return { deleted: { id: v.id, name: v.name }, saved: await commit(m) };
      }),
    move: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const v = findView(m, args.view);
        const after = args.after === null || args.after === undefined ? null : findView(m, args.after, "after").id;
        moveView(m.doc, v.id, after);
        return { views: readViews(m.doc).map((x) => ({ id: x.id, name: x.name })), saved: await commit(m) };
      }),
    duplicate: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const v = findView(m, args.view);
        const id = duplicateView(m.doc, v.id)!;
        const fresh = await modelOf(s, m.found);
        return { view: viewJson(fresh, findView(fresh, id)), saved: await commit(m) };
      }),
  };

  const rowsFor = async (args: Record<string, unknown>) => {
    if (args.database !== undefined) return model(s, args.database);
    const ids = (args.rows as unknown[] | undefined) ?? [];
    const first = ids[0];
    const ref = typeof first === "string" ? first : first && typeof first === "object" ? (first as Record<string, unknown>).id : args.row;
    const row = await s.page(ref, { field: "row", archived: true });
    if (!row.meta.parent) throw new ToolError(`'${displayTitle(row.meta)}' isn't a database row.`);
    return model(s, row.meta.parent, "row's database");
  };

  const rowIn = (m: Model, ref: unknown, field: string, archived = false): PageMeta => {
    if (typeof ref !== "string") throw new ToolError(`${field} must be a row id.`);
    const meta = getPage(m.tree, ref);
    if (!meta || meta.deleted || meta.parent !== m.source) throw new ToolError(`${field}: ${String(ref).slice(0, 40)} isn't a row of '${displayTitle(m.found.meta)}'.`);
    if (meta.archivedAt && !archived) throw new ToolError(`${field}: row ${ref} is in the trash; rows restore it first.`);
    return meta;
  };

  const rows = {
    query: async (args: Record<string, unknown>) => {
      const m = await model(s, args.database);
      const base = args.view !== undefined ? findView(m, args.view) : null;
      const view: View = {
        ...(base ?? readViews(m.doc)[0] ?? ({} as View)),
        type: base?.type ?? "table",
        filter: args.filter !== undefined ? filterIn(m, args.filter, "rows query.filter") : (base?.filter ?? { kind: "group", id: "root", op: "and", rules: [] }),
        sorts: args.sorts !== undefined ? (args.sorts as unknown[]).map((raw, i) => {
          const r = typeof raw === "string" ? { prop: raw } : (raw as Record<string, unknown>);
          const dir = r.dir ?? r.direction ?? "asc";
          if (dir !== "asc" && dir !== "desc") throw new ToolError(`rows query.sorts[${i}].dir must be 'asc' or 'desc'.`);
          return { id: `s${i}`, prop: findProp(m, r.prop ?? r.property, `rows query.sorts[${i}].prop`).id, dir: dir as "asc" | "desc" };
        }) : (base?.sorts ?? []),
        groupBy: base?.groupBy ?? null,
      };
      const result = computeView(m.ctx, view, typeof args.search === "string" ? args.search : "");
      const offset = args.cursor !== undefined ? Number(args.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0) throw new ToolError("rows query.cursor must be the nextCursor of an earlier query.");
      const limit = (args.limit as number) ?? 50;
      const only = args.properties !== undefined ? (args.properties as string[]).map((r, i) => findProp(m, r, `rows query.properties[${i}]`)) : undefined;
      const page = result.rows.slice(offset, offset + limit);
      const withContent = args.content === true;
      const out = [];
      for (const r of page) {
        const json: Record<string, unknown> = rowJson(m, r, { keys: args.keys as "names" | "ids", ...(only ? { only } : {}) });
        if (withContent) json.markdown = await s.markdown({ ws: m.ws, tree: m.tree, meta: r }, { title: false });
        out.push(json);
      }
      return {
        database: m.id,
        total: result.total,
        rows: out,
        nextCursor: offset + limit < result.total ? String(offset + limit) : null,
        ...(result.groups ? { groups: result.groups.map((g) => ({ key: g.key, label: g.label, count: g.rows.length, hidden: g.hidden })) } : {}),
      };
    },
    get: async (args: Record<string, unknown>) => {
      const row = await s.page(args.row, { field: "row", archived: true });
      if (!row.meta.parent) throw new ToolError(`'${displayTitle(row.meta)}' isn't a database row; use pages get.`);
      const parent = getPage(row.tree, row.meta.parent);
      if (!parent || parent.kind !== "database") throw new ToolError(`'${displayTitle(row.meta)}' isn't a database row; use pages get.`);
      const m = await model(s, parent.id);
      const json: Record<string, unknown> = rowJson(m, row.meta, { keys: args.keys as "names" | "ids" });
      if (args.content !== false) json.markdown = await s.markdown(row, { title: false });
      return { database: m.id, row: json };
    },
    create: async (args: Record<string, unknown>) =>
      edit(args.database, async (m) => {
        const list = args.rows as Record<string, unknown>[];
        const created: string[] = [];
        let after: string | null | undefined = args.after === undefined ? undefined : args.after === null ? null : rowIn(m, args.after, "after").id;
        const prepared = list.map((r, i) => {
          const f = `rows[${i}]`;
          for (const k of Object.keys(r)) if (!["title", "icon", "properties", "markdown", "blocks", "template"].includes(k)) throw new ToolError(`unknown field '${k}' in ${f}${suggest(k, ["title", "icon", "properties", "markdown", "blocks", "template"])}`);
          if (r.title !== undefined && typeof r.title !== "string") throw new ToolError(`${f}.title must be text.`);
          const cells = cellsIn(m, r.properties, `${f}.properties`, args.createOptions !== false);
          const template = r.template !== undefined ? m.templates.find((t) => t.id === r.template || t.title.toLowerCase() === String(r.template).toLowerCase()) : null;
          if (r.template !== undefined && !template) throw new ToolError(`${f}.template: no template '${String(r.template)}'${suggest(String(r.template), m.templates.map((t) => t.title))}`);
          const body = r.markdown !== undefined ? markdownToBlocks(String(r.markdown), `${f}.markdown`) : r.blocks !== undefined ? (r.blocks as unknown[]).map((b, j) => cleanBlock(b, `${f}.blocks[${j}]`)) : null;
          return { r, cells, template, body };
        });
        for (const { r, cells, template, body } of prepared) {
          let id: string;
          const defaultTemplate = template === null && r.template === undefined ? m.templates.find((t) => t.id === readSettings(m.doc).defaultTemplate) : undefined;
          const tpl = template ?? defaultTemplate;
          if (tpl) {
            const { page } = (await s.a.run("createPage", { workspace: m.ws, parent: m.source, kind: "page", title: r.title ?? tpl.title, props: duplicateRowProps(tpl, m.schema), template: tpl.id, ...(after ? { after } : {}) })) as { page: string };
            id = page;
            m.tree.transact(() => {
              pagesOf(m.tree).get(id)?.set("isTemplate", false);
              for (const p of m.schema) if (p.type === "id") setProp(m.tree, id, p.id, nextIdNumber(m.tree, m.source, p.id), by());
            });
          } else id = createRow(m.tree, m.source, m.schema, { by: by(), ...(typeof r.title === "string" ? { title: r.title } : {}), ...(after !== undefined ? { after } : {}), now: s.a.now() });
          if (typeof r.icon === "string") updatePage(m.tree, id, { icon: r.icon }, by());
          applyCells(m, id, cells, by());
          if (body) {
            const doc = await s.a.doc(m.ws, id);
            doc.transact(() => writeDoc(blocksOf(doc), body));
          }
          created.push(id);
          after = id;
        }
        const saved = await commit(m, created);
        const fresh = await modelOf(s, m.found);
        return { database: m.id, created: created.map((id) => rowJson(fresh, getPage(fresh.tree, id)!)), saved };
      }),
    update: async (args: Record<string, unknown>) => {
      const m0 = await rowsFor(args);
      return edit(m0.id, async (m) => {
        const list = args.rows as Record<string, unknown>[];
        const prepared = list.map((r, i) => {
          const f = `rows[${i}]`;
          if (!r || typeof r !== "object") throw new ToolError(`${f} must be {id, title?, icon?, properties?}.`);
          for (const k of Object.keys(r)) if (!["id", "title", "icon", "properties"].includes(k)) throw new ToolError(`unknown field '${k}' in ${f}${suggest(k, ["id", "title", "icon", "properties"])}`);
          const row = rowIn(m, r.id, `${f}.id`);
          if (r.title !== undefined && typeof r.title !== "string") throw new ToolError(`${f}.title must be text.`);
          if (r.icon !== undefined && typeof r.icon !== "string") throw new ToolError(`${f}.icon must be an emoji.`);
          return { row, r, cells: cellsIn(m, r.properties, `${f}.properties`, args.createOptions !== false) };
        });
        m.tree.transact(() => {
          for (const { row, r, cells } of prepared) {
            if (r.title !== undefined || r.icon !== undefined) updatePage(m.tree, row.id, { ...(r.title !== undefined ? { title: String(r.title).slice(0, 2000) } : {}), ...(r.icon !== undefined ? { icon: String(r.icon) } : {}) }, by());
            applyCells(m, row.id, cells, by());
          }
        });
        const saved = await commit(m);
        const fresh = await modelOf(s, m.found);
        return { database: m.id, updated: prepared.map(({ row }) => rowJson(fresh, getPage(fresh.tree, row.id)!)), saved };
      });
    },
    delete: async (args: Record<string, unknown>) => {
      const m0 = await rowsFor(args);
      return edit(m0.id, async (m) => {
        const ids = (args.rows as string[]).map((id, i) => rowIn(m, id, `rows[${i}]`).id);
        m.tree.transact(() => ids.forEach((id) => archivePage(m.tree, id, by(), s.a.now())));
        return { database: m.id, trashed: ids, saved: await commit(m) };
      });
    },
    restore: async (args: Record<string, unknown>) => {
      const m0 = await rowsFor(args);
      return edit(m0.id, async (m) => {
        const ids = (args.rows as string[]).map((id, i) => rowIn(m, id, `rows[${i}]`, true).id);
        m.tree.transact(() => ids.forEach((id) => restorePage(m.tree, id, by())));
        return { database: m.id, restored: ids, saved: await commit(m) };
      });
    },
    duplicate: async (args: Record<string, unknown>) => {
      const m0 = await rowsFor(args);
      return edit(m0.id, async (m) => {
        const ids = (args.rows as string[]).map((id, i) => rowIn(m, id, `rows[${i}]`).id);
        const out: string[] = [];
        for (const id of ids) {
          const { page } = (await s.a.run("duplicatePage", { workspace: m.ws, page: id })) as { page: string };
          for (const p of m.schema) if (p.type === "id") setProp(m.tree, page, p.id, nextIdNumber(m.tree, m.source, p.id), by());
          out.push(page);
        }
        const fresh = await modelOf(s, m.found);
        return { database: m.id, created: out.map((id) => rowJson(fresh, getPage(fresh.tree, id)!)), saved: await commit(m, out) };
      });
    },
    move: async (args: Record<string, unknown>) => {
      const m0 = await rowsFor({ ...args, rows: [args.row] });
      return edit(m0.id, async (m) => {
        const row = rowIn(m, args.row, "row");
        const after = args.after === null || args.after === undefined ? null : rowIn(m, args.after, "after").id;
        movePage(m.tree, row.id, m.source, after, by());
        return { database: m.id, order: databaseRows(m.tree, m.source).map((r) => r.id), saved: await commit(m) };
      });
    },
  };

  return { database, properties, views, rows };
}

function relationTargets(m: Model, id: string) {
  const p = readSchema(m.schemaDoc).find((x) => x.id === id);
  return p && p.type === "relation" && p.relation ? [p.relation] : [];
}

async function addPropertyFrom(s: Session, m: Model, args: Record<string, unknown>, field: string): Promise<string> {
  const allowed = ["name", "type", "after", "description", ...Object.keys(PROPERTY_FIELDS)];
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new ToolError(`unknown field '${k}' in ${field}${suggest(k, allowed)}`);
  const type = args.type as PropType;
  if (!type || !PROP_TYPE_IDS.includes(type)) throw new ToolError(`${field}.type must be one of ${quoteList(PROP_TYPE_IDS)}${typeof type === "string" ? suggest(type, PROP_TYPE_IDS) : ""}`);
  const name = args.name === undefined ? undefined : String(args.name).slice(0, 200);
  if (name && m.schema.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new ToolError(`${field}: '${displayTitle(m.found.meta)}' already has a property called '${name}'.`);
  const after = args.after === undefined ? undefined : args.after === null ? null : findProp(m, args.after, `${field}.after`).id;
  if (type === "relation") {
    if (args.relation === undefined) throw new ToolError(`${field}.relation is required for a relation: the database it links to (id or title).`);
    const target = await targetDatabase(s, m, args.relation, `${field}.relation`);
    const twoWay = args.twoWay === true;
    const id = addRelationProperty(m.schemaDoc, { name: name ?? "Relation", target: target.found.meta.id, source: m.source, twoWay, targetDoc: target.doc, sourceName: displayTitle(m.found.meta) });
    if (twoWay && args.relatedName !== undefined) {
      const prop = readSchema(m.schemaDoc).find((p) => p.id === id)!;
      updateProperty(target.found.meta.id === m.source ? m.schemaDoc : target.doc, prop.backProp, { name: String(args.relatedName).slice(0, 200) });
    }
    if (after !== undefined) moveProperty(m.schemaDoc, id, after);
    if (args.description !== undefined) updateProperty(m.schemaDoc, id, { description: String(args.description) });
    return id;
  }
  const config = propertyConfig(m, null, type, args, field);
  const options = args.options !== undefined ? cleanOptionsIn(args.options, `${field}.options`, type === "status") : undefined;
  const id = addProperty(m.schemaDoc, { type, ...(name ? { name } : {}), ...config, ...(options ? { options } : {}), ...(type === "id" && config.prefix === undefined ? { prefix: "" } : {}) }, after !== undefined ? { after } : {});
  if (type === "id") {
    const sorted = [...m.rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    m.tree.transact(() => sorted.forEach((r, i) => setProp(m.tree, r.id, id, i + 1, s.a.deviceId())));
  }
  for (const v of m.views) if (v.type === "table") setViewProp(m.doc, v.id, id, { visible: true });
  return id;
}

export const SCHEMA_INFO = {
  propertyTypes: PROP_TYPES.map((p) => ({ type: p.type, label: p.label, editable: isEditable(p.type) })),
  colors: COLOR_IDS,
  statusGroups: STATUS_GROUPS.map((g) => g.id),
  numberFormats: NUMBER_FORMATS.map((f) => f.id),
  dateFormats: DATE_FORMATS.map((f) => f.id),
  rollupFunctions: ROLLUP_FNS,
  calculations: CALC_FNS,
  formulaFunctions: FORMULA_FUNCTIONS,
  relativeDates: RELATIVE_RANGES.map((r) => r.id),
  viewTypes: VIEW_TYPE_IDS,
  filterConditions: {
    text: condsFor("text").map((c) => c.id),
    number: condsFor("number").map((c) => c.id),
    select: condsFor("select").map((c) => c.id),
    multi: condsFor("multi").map((c) => c.id),
    person: condsFor("person").map((c) => c.id),
    relation: condsFor("relation").map((c) => c.id),
    files: condsFor("files").map((c) => c.id),
    date: condsFor("date").map((c) => c.id),
    checkbox: condsFor("checkbox").map((c) => c.id),
  },
  filterKinds: "text: title, text, url, email, phone; number: number, id; select: select, status; multi: multi_select; date: date, created_time, edited_time; person: person, created_by, edited_by; formula and rollup take the kind of their result",
  allConditions: CONDS,
};
