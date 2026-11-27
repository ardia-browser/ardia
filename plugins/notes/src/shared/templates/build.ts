import type * as Y from "yjs";
import { writeBlocks, type BlockSpec, type Inline } from "../blocks";
import {
  addDays,
  addProperty,
  addView,
  createRow,
  propEntry,
  readSchema,
  rememberPerson,
  setCalc,
  setViewProp,
  settingsOf,
  startOfDay,
  syncBackRelation,
  TITLE,
  toDateString,
  updateProperty,
  updateSettings,
  type Color,
  type FilterGroup,
  type FilterRule,
  type GroupBy,
  type Property,
  type PropertyInput,
  type SelectOption,
} from "../database";
import { createPage, newId, orderBetween, pagesOf, updatePage } from "../model";
import type { PageId } from "../protocol";
import { DATE_REF, REF, VIEW_REF } from "./dsl";
import type { CellValue, DatabaseSpec, DateCell, FilterSpec, GroupSpec, NodeSpec, OptionSpec, PageSpec, PropSpec, RowSpec, TemplateSpec, ViewSpec } from "./types";

export type TemplateTarget = { tree: Y.Doc; by: string; newDoc: (page: PageId) => Y.Doc; now?: number };

export type InstantiateOptions = {
  parent?: PageId | "";
  after?: PageId | null;
  into?: { page: PageId; doc: Y.Doc };
  me?: { name: string; color: string };
  lock?: boolean;
};

export type Instantiated = { page: PageId; pages: PageId[]; databases: PageId[]; rows: PageId[]; refs: Map<string, PageId> };

export const SAMPLE_PEOPLE: Record<string, { name: string; color: string }> = {
  alex: { name: "Alex Rivera", color: "#4691c3" },
  sam: { name: "Sam Okafor", color: "#3eb489" },
  priya: { name: "Priya Nair", color: "#c07a98" },
  jordan: { name: "Jordan Lee", color: "#d87249" },
  mei: { name: "Mei Tanaka", color: "#7873af" },
};

export const PERSON_ME = "me";
export const samplePersonId = (key: string) => `sample-${key}`;

const OPTION_CYCLE: Color[] = ["blue", "green", "orange", "purple", "pink", "yellow", "red", "brown", "gray"];
const COMPUTED = new Set(["formula", "rollup", "created_time", "created_by", "edited_time", "edited_by", "id"]);

export class TemplateError extends Error {}

const fail = (template: string, what: string): never => {
  throw new TemplateError(`${template}: ${what}`);
};

type DbState = { spec: DatabaseSpec; id: PageId; doc: Y.Doc; props: Map<string, string>; views: Map<string, string> };

function walkNodes(node: NodeSpec, visit: (node: NodeSpec, parent: NodeSpec | null) => void, parent: NodeSpec | null = null) {
  visit(node, parent);
  if (node.kind === "page") for (const child of node.children ?? []) walkNodes(child, visit, node);
}

export function allNodes(template: TemplateSpec): NodeSpec[] {
  const out: NodeSpec[] = [];
  walkNodes(template.root, (n) => out.push(n));
  return out;
}

function normalizeOptions(options: OptionSpec[] | undefined): Omit<SelectOption, "id" | "order">[] | undefined {
  if (!options) return undefined;
  return options.map((o, index) => {
    if (typeof o === "string") return { name: o, color: OPTION_CYCLE[index % OPTION_CYCLE.length]! };
    return { name: o.name, color: o.color ?? OPTION_CYCLE[index % OPTION_CYCLE.length]!, ...(o.group ? { group: o.group } : {}) };
  });
}

function propInput(spec: PropSpec): PropertyInput & { type: PropSpec["type"] } {
  const input: PropertyInput & { type: PropSpec["type"] } = { type: spec.type, name: spec.name };
  const options = normalizeOptions(spec.options);
  if (options) input.options = options;
  for (const field of ["format", "display", "divideBy", "barColor", "showNumber", "dateFormat", "timeFormat", "expression", "prefix", "description"] as const) {
    if (spec[field] !== undefined) (input as Record<string, unknown>)[field] = spec[field];
  }
  return input;
}

export function dateCell(cell: DateCell, now: number): { start: string; end?: string } {
  const day = startOfDay(now);
  const stamp = (offset: number, time?: string) => {
    const base = addDays(day, offset);
    if (!time) return toDateString(base);
    const [h, m] = time.split(":").map(Number);
    return toDateString(base + ((h ?? 0) * 60 + (m ?? 0)) * 60_000, true);
  };
  const start = stamp(cell.d, cell.at);
  if (cell.end === undefined && cell.endAt === undefined) return { start };
  return { start, end: stamp(cell.end ?? cell.d, cell.endAt ?? cell.at) };
}

export function instantiateTemplate(target: TemplateTarget, template: TemplateSpec, options: InstantiateOptions = {}): Instantiated {
  const { tree, by } = target;
  const now = target.now ?? Date.now();
  const name = template.id;
  const refs = new Map<string, PageId>();
  const nodeIds = new Map<NodeSpec, PageId>();
  const rowIds = new Map<RowSpec, PageId>();
  const nodes = allNodes(template);
  const root = template.root;
  const intoPage = options.into && root.kind === "page" ? options.into.page : null;

  const claim = (key: string | undefined, id: PageId) => {
    if (!key) return;
    if (refs.has(key)) fail(name, `the key "${key}" is used twice`);
    refs.set(key, id);
  };
  for (const node of nodes) {
    const id = node === root && intoPage ? intoPage : newId();
    nodeIds.set(node, id);
    claim(node.key, id);
    if (node.kind === "database") for (const row of [...node.rows, ...(node.rowTemplates ?? [])]) {
      const rowId = newId();
      rowIds.set(row, rowId);
      claim(row.key, rowId);
    }
  }
  const resolveRef = (key: string) => refs.get(key) ?? fail(name, `nothing has the key "${key}"`);

  const pages: PageId[] = [];
  const databases: PageId[] = [];
  const rows: PageId[] = [];
  const dbStates: DbState[] = [];
  const pageDocs: { spec: PageSpec; doc: Y.Doc }[] = [];
  const views = new Map<string, string>();

  tree.transact(() => {
    walkNodes(root, (node, parent) => {
      const id = nodeIds.get(node)!;
      const isRoot = node === root;
      const parentId = isRoot ? (options.into ? options.into.page : (options.parent ?? "")) : nodeIds.get(parent!)!;
      if (!(isRoot && intoPage)) {
        createPage(tree, {
          id,
          parent: parentId,
          kind: node.kind,
          title: node.title,
          icon: node.icon ?? "",
          ...(isRoot && !options.into && options.after !== undefined ? { after: options.after } : {}),
          props: node.kind === "database" && (node.inline || (isRoot && options.into)) ? { inline: true } : {},
          by,
          now,
        });
      }
      const patch: Record<string, unknown> = {};
      if (node.cover) patch.cover = node.cover;
      if (node.kind === "page" && node.font) patch.font = node.font;
      if (node.kind === "page" && node.fullWidth) patch.fullWidth = true;
      if (node.kind === "page" && node.smallText) patch.smallText = true;
      if (options.lock) patch.locked = true;
      if (isRoot && intoPage) {
        const entry = pagesOf(tree).get(intoPage);
        if (entry && !String(entry.get("title") ?? "").trim()) patch.title = node.title;
        if (entry && !entry.get("icon") && node.icon) patch.icon = node.icon;
        if (entry && entry.get("cover")) delete patch.cover;
      }
      if (Object.keys(patch).length) updatePage(tree, id, patch, by, now);
      if (node.kind === "page") {
        pages.push(id);
        pageDocs.push({ spec: node, doc: isRoot && intoPage ? options.into!.doc : target.newDoc(id) });
      } else {
        databases.push(id);
        dbStates.push({ spec: node, id, doc: target.newDoc(id), props: new Map(), views: new Map() });
      }
    });
  });

  const byKey = new Map<string, DbState>();
  for (const state of dbStates) if (state.spec.key) byKey.set(state.spec.key, state);
  const dbOf = (key: string) => byKey.get(key) ?? fail(name, `no database has the key "${key}"`);

  for (const state of dbStates) {
    const { spec, doc } = state;
    doc.transact(() => {
      settingsOf(doc).set("initialized", true);
      propEntry(doc, TITLE).set("name", spec.titleName ?? "Name");
      state.props.set("title", TITLE);
      for (const prop of spec.properties) {
        if (state.props.has(prop.key)) fail(name, `${spec.title} has two properties with the key "${prop.key}"`);
        if (prop.type === "relation" || prop.type === "rollup") continue;
        state.props.set(prop.key, addProperty(doc, propInput(prop), { id: newId() }));
      }
      const settings: Record<string, unknown> = {};
      if (spec.description) Object.assign(settings, { description: spec.description, showDescription: true });
      if (spec.openAs) settings.openAs = spec.openAs;
      if (options.lock) settings.locked = true;
      if (Object.keys(settings).length) updateSettings(doc, settings);
    });
  }

  const backProps: { db: DbState; prop: string }[] = [];
  for (const state of dbStates) {
    for (const prop of state.spec.properties) {
      if (prop.type !== "relation") continue;
      if (!prop.relation) fail(name, `${prop.name} in ${state.spec.title} needs a relation`);
      const other = dbOf(prop.relation!);
      const id = newId();
      const back = prop.twoWay ? newId() : "";
      state.props.set(prop.key, id);
      addProperty(state.doc, { type: "relation", name: prop.name, relation: other.id, twoWay: !!prop.twoWay, backProp: back, ...(prop.description ? { description: prop.description } : {}) }, { id });
      if (prop.twoWay) {
        addProperty(other.doc, { type: "relation", name: prop.twoWay, relation: state.id, twoWay: true, backProp: id }, { id: back });
        const alias = `${prop.key}~`;
        if (!other.props.has(alias)) other.props.set(alias, back);
        backProps.push({ db: state, prop: id }, { db: other, prop: back });
      }
    }
  }

  for (const state of dbStates) {
    for (const prop of state.spec.properties) {
      if (prop.type !== "rollup") continue;
      const rollup = prop.rollup ?? fail(name, `${prop.name} in ${state.spec.title} needs a rollup`);
      const relationId = state.props.get(rollup.relation) ?? fail(name, `${prop.name} rolls up "${rollup.relation}", which isn't a relation in ${state.spec.title}`);
      const relationSpec = state.spec.properties.find((p) => p.key === rollup.relation && p.type === "relation");
      const targetDb = relationSpec?.relation ? dbOf(relationSpec.relation) : backTarget(state, rollup.relation);
      const targetProp = rollup.target === "title" ? TITLE : (targetDb.props.get(rollup.target) ?? fail(name, `${prop.name} rolls up "${rollup.target}", which ${targetDb.spec.title} doesn't have`));
      const id = newId();
      state.props.set(prop.key, id);
      addProperty(state.doc, { ...propInput(prop), type: "rollup", rollupRelation: relationId, rollupTarget: targetProp, rollupFn: rollup.fn }, { id });
    }
    state.doc.transact(() => {
      let last: string | null = null;
      for (const prop of state.spec.properties) {
        last = orderBetween(last, null);
        updateProperty(state.doc, state.props.get(prop.key)!, { order: last });
      }
    });
  }

  function backTarget(state: DbState, alias: string): DbState {
    if (!alias.endsWith("~")) return fail(name, `"${alias}" isn't a relation in ${state.spec.title}`);
    const source = dbStates.find((s) => s.spec.properties.some((p) => p.key === alias.slice(0, -1) && p.type === "relation" && p.relation === state.spec.key));
    return source ?? fail(name, `"${alias}" isn't a relation in ${state.spec.title}`);
  }

  const people = new Set<string>();
  const personId = (key: string) => {
    if (key === PERSON_ME) return by;
    if (!SAMPLE_PEOPLE[key]) fail(name, `"${key}" isn't a sample person`);
    people.add(key);
    return samplePersonId(key);
  };

  for (const state of dbStates) {
    const schema = readSchema(state.doc);
    const propOf = (key: string): Property => {
      const id = state.props.get(key) ?? fail(name, `${state.spec.title} has no property "${key}"`);
      return schema.find((p) => p.id === id) ?? fail(name, `${state.spec.title} lost "${key}"`);
    };
    const optionId = (prop: Property, option: unknown) => {
      const found = prop.options.find((o) => o.name === option);
      return found ? found.id : fail(name, `${prop.name} in ${state.spec.title} has no option "${String(option)}"`);
    };
    const filterValue = (prop: Property, value: unknown): unknown => {
      if (value === undefined) return undefined;
      if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") return (Array.isArray(value) ? value : [value]).map((v) => optionId(prop, v));
      if (prop.type === "person") return (Array.isArray(value) ? value : [value]).map((v) => personId(String(v)));
      if (prop.type === "relation") return (Array.isArray(value) ? value : [value]).map((v) => resolveRef(String(v)));
      return value;
    };
    const filterOf = (list: FilterSpec[], op: "and" | "or", id = "root"): FilterGroup => ({
      kind: "group",
      id,
      op,
      rules: list.map((f): FilterRule | FilterGroup => {
        if ("any" in f) return filterOf(f.any, "or", newId());
        if ("all" in f) return filterOf(f.all, "and", newId());
        const prop = propOf(f.prop);
        const value = filterValue(prop, f.value);
        return { kind: "rule", id: newId(), prop: prop.id, cond: f.cond, ...(value !== undefined ? { value } : {}) };
      }),
    });
    const groupOf = (g: GroupSpec): Partial<GroupBy> => ({ prop: propOf(g.prop).id, ...(g.date ? { date: g.date } : {}), ...(g.status ? { status: g.status } : {}), ...(g.hideEmpty ? { hideEmpty: true } : {}), ...(g.sort ? { sort: g.sort } : {}) });
    for (const view of state.spec.views) {
      const id = newId();
      const init = viewInit(view, propOf, filterOf, groupOf);
      addView(state.doc, view.type, { id, name: view.name, init });
      if (view.key) {
        state.views.set(view.key, id);
        if (state.spec.key) views.set(`${state.spec.key}.${view.key}`, id);
      }
      state.doc.transact(() => {
        let last: string | null = null;
        for (const key of view.show ?? []) {
          last = orderBetween(last, null);
          setViewProp(state.doc, id, propOf(key).id, { visible: true, order: last });
        }
        for (const key of view.hide ?? []) setViewProp(state.doc, id, propOf(key).id, { visible: false });
        for (const [key, width] of Object.entries(view.widths ?? {})) setViewProp(state.doc, id, propOf(key).id, { width });
        for (const [key, fn] of Object.entries(view.calcs ?? {})) setCalc(state.doc, id, propOf(key).id, fn);
      });
    }
    if (!state.spec.views.length) fail(name, `${state.spec.title} has no views`);

    const cell = (prop: Property, value: CellValue): unknown => {
      if (value === null) return null;
      if (COMPUTED.has(prop.type)) fail(name, `${prop.name} in ${state.spec.title} is computed and can't be set`);
      switch (prop.type) {
        case "title":
          return fail(name, "set a row's title with its title field");
        case "text":
        case "url":
        case "email":
        case "phone":
          return typeof value === "string" ? value : fail(name, `${prop.name} wants text`);
        case "number":
          return typeof value === "number" && Number.isFinite(value) ? value : fail(name, `${prop.name} wants a number`);
        case "checkbox":
          return typeof value === "boolean" ? value : fail(name, `${prop.name} wants true or false`);
        case "select":
        case "status":
          return optionId(prop, value);
        case "multi_select":
          return (Array.isArray(value) ? value : fail(name, `${prop.name} wants a list`)).map((v) => optionId(prop, v));
        case "person":
          return (Array.isArray(value) ? value : [String(value)]).map((v) => personId(String(v)));
        case "relation":
          return (Array.isArray(value) ? value : fail(name, `${prop.name} wants a list of row keys`)).map((v) => resolveRef(String(v)));
        case "date":
          return value && typeof value === "object" && !Array.isArray(value) && typeof (value as DateCell).d === "number" ? dateCell(value as DateCell, now) : fail(name, `${prop.name} wants a date cell`);
        default:
          return fail(name, `${prop.name} in ${state.spec.title} can't hold template data`);
      }
    };

    const writeRow = (row: RowSpec, isTemplate: boolean) => {
      const id = rowIds.get(row)!;
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.values ?? {})) {
        const prop = propOf(key);
        const v = cell(prop, value);
        if (v !== null && v !== undefined) props[prop.id] = v;
      }
      createRow(tree, state.id, schema, { by, title: row.title, props, id, now, isTemplate });
      const patch: Record<string, unknown> = {};
      if (row.icon) patch.icon = row.icon;
      if (row.cover) patch.cover = row.cover;
      if (options.lock) patch.locked = true;
      if (Object.keys(patch).length) updatePage(tree, id, patch, by, now);
      if (row.blocks?.length) pageDocs.push({ spec: { kind: "page", title: row.title, blocks: row.blocks }, doc: target.newDoc(id) });
      rows.push(id);
      return id;
    };
    tree.transact(() => {
      for (const row of state.spec.rows) writeRow(row, false);
      for (const row of state.spec.rowTemplates ?? []) {
        const id = writeRow(row, true);
        if (row.isDefault) updateSettings(state.doc, { defaultTemplate: id });
      }
    });
  }

  for (const { db, prop } of backProps) {
    const schema = readSchema(db.doc).find((p) => p.id === prop);
    if (schema) syncBackRelation(tree, db.id, schema, by);
  }

  for (const state of dbStates) {
    state.doc.transact(() => {
      for (const key of people) rememberPerson(state.doc, { id: samplePersonId(key), ...SAMPLE_PEOPLE[key]! });
      if (options.me) rememberPerson(state.doc, { id: by, name: options.me.name || "You", color: options.me.color });
    });
  }

  const resolveValue = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    if (typeof v[REF] === "string") return resolveRef(v[REF]);
    if (typeof v[VIEW_REF] === "string") return views.get(v[VIEW_REF]) ?? fail(name, `no view "${v[VIEW_REF]}"`);
    if (typeof v[DATE_REF] === "number") return toDateString(addDays(startOfDay(now), v[DATE_REF]));
    return value;
  };
  const resolveAttrs = (attrs: Record<string, unknown> | undefined) => (attrs ? Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, resolveValue(v)])) : undefined);
  const resolveInline = (part: Inline): Inline => (typeof part === "object" && "node" in part ? { node: part.node, attrs: resolveAttrs(part.attrs)! } : part);
  const resolveBlock = (block: BlockSpec): BlockSpec => ({
    type: block.type,
    ...(block.attrs ? { attrs: resolveAttrs(block.attrs) } : {}),
    ...(block.content ? { content: block.content.map(resolveInline) } : {}),
    ...(block.children ? { children: block.children.map(resolveBlock) } : {}),
  });

  for (const { spec, doc } of pageDocs) writeBlocks(doc, spec.blocks.map(resolveBlock));
  if (options.into && root.kind === "database") {
    writeBlocks(options.into.doc, [{ type: "database", attrs: { workspace: "", database: nodeIds.get(root)!, view: "" } }, { type: "paragraph" }]);
    const entry = pagesOf(tree).get(options.into.page);
    if (entry) {
      const patch: Record<string, unknown> = {};
      if (!String(entry.get("title") ?? "").trim()) patch.title = root.title;
      if (!entry.get("icon") && root.icon) patch.icon = root.icon;
      if (Object.keys(patch).length) updatePage(tree, options.into.page, patch, by, now);
    }
  }

  return { page: options.into ? options.into.page : nodeIds.get(root)!, pages, databases, rows, refs };
}

function viewInit(
  view: ViewSpec,
  propOf: (key: string) => Property,
  filterOf: (list: FilterSpec[], op: "and" | "or") => FilterGroup,
  groupOf: (g: GroupSpec) => Partial<GroupBy>,
): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  if (view.filter?.length) init.filter = filterOf(view.filter, view.filterOp ?? "and");
  if (view.sorts?.length) init.sorts = view.sorts.map((s) => ({ id: newId(), prop: propOf(s.prop).id, dir: s.dir }));
  if (view.group) init.groupBy = groupOf(view.group);
  if (view.subGroup) init.subGroupBy = groupOf(view.subGroup);
  if (view.date) init.dateProp = propOf(view.date).id;
  if (view.end) init.endProp = propOf(view.end).id;
  if (view.chart) {
    init.chartType = view.chart.type;
    init.chartBy = propOf(view.chart.by).id;
    if (view.chart.agg) init.chartAgg = view.chart.agg;
    if (view.chart.value) init.chartValue = propOf(view.chart.value).id;
  }
  for (const field of ["zoom", "showTable", "showWeekends", "cardPreview", "cardSize", "fitImage", "colorColumns", "wrap", "limit"] as const) if (view[field] !== undefined) init[field] = view[field];
  return init;
}
