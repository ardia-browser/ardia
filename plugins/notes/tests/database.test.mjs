import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let D;
let M;
let Y;

before(async () => {
  const dir = join(tmpdir(), "ardia-notes-tests");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `database-${process.pid}-${Date.now()}.mjs`);
  const src = fileURLToPath(new URL("../src/shared/", import.meta.url));
  await build({
    stdin: {
      contents: `export * as D from "./database"; export * as M from "./model"; export * as Y from "yjs";`,
      resolveDir: src,
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
  });
  const mod = await import(pathToFileURL(outfile).href);
  D = mod.D;
  M = mod.M;
  Y = mod.Y;
});

const BY = "dev-a";

function setup() {
  const tree = new Y.Doc();
  const dbId = M.createPage(tree, { parent: "", kind: "database", title: "Tasks", by: BY });
  const doc = new Y.Doc();
  D.initDatabase(doc);
  return { tree, dbId, doc };
}

function ctxOf(tree, dbId, doc, extra = {}) {
  const docs = extra.docs ?? {};
  return D.makeContext({
    database: dbId,
    schema: D.readSchema(doc),
    rows: D.databaseRows(tree, dbId),
    page: (id) => M.getPage(tree, id),
    schemaFor: (id) => (id === dbId ? D.readSchema(doc) : docs[id] ? D.readSchema(docs[id]) : null),
    rowsFor: (id) => D.databaseRows(tree, id),
    people: extra.people ?? new Map(),
    now: extra.now ?? new Date(2026, 10, 23, 12, 0).getTime(),
  });
}

function sync(a, b) {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua);
  Y.applyUpdate(a, ub);
}

const prop = (doc, id) => D.readSchema(doc).find((p) => p.id === id);
const byName = (doc, name) => D.readSchema(doc).find((p) => p.name === name);
const titles = (rows) => rows.map((r) => r.title);
const rule = (p, cond, value) => ({ kind: "rule", id: Math.random().toString(36).slice(2), prop: p, cond, ...(value !== undefined ? { value } : {}) });
const group = (op, rules) => ({ kind: "group", id: "g", op, rules });

describe("schema", () => {
  test("init creates title, tags and a default table view, idempotently", () => {
    const { doc } = setup();
    D.initDatabase(doc);
    const schema = D.readSchema(doc);
    assert.equal(schema[0].id, D.TITLE);
    assert.equal(schema[0].type, "title");
    assert.equal(schema[0].name, "Name");
    assert.ok(schema.some((p) => p.id === D.DEFAULT_TAGS && p.type === "multi_select"));
    const views = D.readViews(doc);
    assert.equal(views.length, 1);
    assert.equal(views[0].id, D.DEFAULT_VIEW);
    assert.equal(views[0].type, "table");
  });

  test("two docs initializing concurrently converge on one default view", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    D.initDatabase(a);
    D.initDatabase(b);
    sync(a, b);
    assert.equal(D.readViews(a).length, 1);
    assert.deepEqual(D.readViews(a).map((v) => v.id), D.readViews(b).map((v) => v.id));
    assert.deepEqual(D.readSchema(a).map((p) => p.id).sort(), D.readSchema(b).map((p) => p.id).sort());
    assert.equal(D.readSchema(a).filter((p) => p.type === "multi_select").length, 1);
  });

  test("add, rename, move, duplicate and delete properties", () => {
    const { doc } = setup();
    const a = D.addProperty(doc, { type: "number", name: "Points" });
    const b = D.addProperty(doc, { type: "text", name: "Notes" });
    const c = D.addProperty(doc, { type: "date", name: "Due" }, { after: D.TITLE });
    let ids = D.readSchema(doc).map((p) => p.id);
    assert.equal(ids[0], D.TITLE);
    assert.equal(ids[1], c);
    assert.ok(ids.indexOf(a) < ids.indexOf(b));
    D.renameProperty(doc, a, "Score");
    assert.equal(prop(doc, a).name, "Score");
    D.renameProperty(doc, a, "x".repeat(500));
    assert.equal(prop(doc, a).name.length, 200);
    D.moveProperty(doc, b, null);
    ids = D.readSchema(doc).map((p) => p.id);
    assert.equal(ids[1], b);
    D.moveProperty(doc, D.TITLE, b);
    assert.equal(D.readSchema(doc)[0].id, D.TITLE);
    const s = D.addProperty(doc, { type: "select", name: "Kind", options: [{ name: "A", color: "red" }, { name: "B", color: "blue" }] });
    const copy = D.duplicateProperty(doc, s);
    assert.equal(prop(doc, copy).name, "Kind (copy)");
    assert.deepEqual(prop(doc, copy).options.map((o) => o.name), ["A", "B"]);
    assert.notDeepEqual(prop(doc, copy).options.map((o) => o.id), prop(doc, s).options.map((o) => o.id));
    assert.equal(D.duplicateProperty(doc, D.TITLE), null);
    D.deleteProperty(doc, a);
    assert.equal(prop(doc, a), undefined);
    D.deleteProperty(doc, D.TITLE);
    assert.ok(prop(doc, D.TITLE));
  });

  test("title type cannot be changed and status gets default groups", () => {
    const { doc } = setup();
    D.updateProperty(doc, D.TITLE, { type: "number" });
    assert.equal(prop(doc, D.TITLE).type, "title");
    const st = D.addProperty(doc, { type: "status", name: "Status" });
    assert.deepEqual(prop(doc, st).options.map((o) => [o.name, o.group]), [["Not started", "todo"], ["In progress", "doing"], ["Done", "done"]]);
    const sel = D.addProperty(doc, { type: "select", name: "S" });
    D.addOption(doc, sel, "x");
    D.updateProperty(doc, sel, { type: "status" });
    assert.ok(prop(doc, sel).options.every((o) => o.group));
  });

  test("options add, update, delete, move, including status groups", () => {
    const { doc } = setup();
    const p = D.DEFAULT_TAGS;
    const a = D.addOption(doc, p, "Alpha");
    const b = D.addOption(doc, p, "Beta");
    const c = D.addOption(doc, p, "Gamma", { color: "pink" });
    assert.deepEqual(prop(doc, p).options.map((o) => o.name), ["Alpha", "Beta", "Gamma"]);
    assert.equal(prop(doc, p).options[2].color, "pink");
    D.updateOption(doc, p, a, { name: "A1", color: "green" });
    assert.equal(prop(doc, p).options[0].name, "A1");
    assert.equal(prop(doc, p).options[0].color, "green");
    D.moveOption(doc, p, c, null);
    assert.deepEqual(prop(doc, p).options.map((o) => o.id), [c, a, b]);
    D.moveOption(doc, p, c, b);
    assert.deepEqual(prop(doc, p).options.map((o) => o.id), [a, b, c]);
    D.deleteOption(doc, p, b);
    assert.deepEqual(prop(doc, p).options.map((o) => o.id), [a, c]);
    assert.equal(D.findOptionByName(prop(doc, p), " a1 ").id, a);

    const st = D.addProperty(doc, { type: "status", name: "Status" });
    const blocked = D.addOption(doc, st, "Blocked", { group: "doing" });
    let opts = prop(doc, st).options;
    assert.deepEqual(opts.map((o) => o.name), ["Not started", "In progress", "Blocked", "Done"]);
    const done = opts.find((o) => o.name === "Done").id;
    D.moveOption(doc, st, done, null, "todo");
    opts = prop(doc, st).options;
    assert.equal(opts[0].id, done);
    assert.equal(opts[0].group, "todo");
    D.moveOption(doc, st, blocked, null, "done");
    opts = prop(doc, st).options;
    assert.equal(opts.at(-1).id, blocked);
    assert.equal(opts.at(-1).group, "done");
  });

  test("settings and people", () => {
    const { doc } = setup();
    assert.equal(D.readSettings(doc).openAs, "side");
    D.updateSettings(doc, { openAs: "center", locked: true, description: "d" });
    assert.equal(D.readSettings(doc).openAs, "center");
    assert.equal(D.readSettings(doc).locked, true);
    D.settingsOf(doc).set("openAs", "evil");
    assert.equal(D.readSettings(doc).openAs, "side");
    D.rememberPerson(doc, { id: "p1", name: "Zed", color: "#fff" });
    D.rememberPerson(doc, { id: "p2", name: "Amy", color: "#000" });
    assert.deepEqual(D.readPeople(doc).map((p) => p.name), ["Amy", "Zed"]);
  });

  test("hostile schema entries read safely", () => {
    const doc = new Y.Doc();
    const e = new Y.Map();
    D.schemaOf(doc).set("__proto__", e);
    e.set("type", "nope");
    e.set("name", 42);
    e.set("divideBy", Infinity);
    const schema = D.readSchema(doc);
    const p = schema.find((x) => x.id === "__proto__");
    assert.equal(p.type, "text");
    assert.equal(p.name, "");
    assert.equal(p.divideBy, 100);
    assert.equal(schema[0].id, D.TITLE);
  });
});

describe("views", () => {
  test("add, update, duplicate, delete, move", () => {
    const { doc } = setup();
    const st = D.addProperty(doc, { type: "status", name: "Status" });
    const due = D.addProperty(doc, { type: "date", name: "Due" });
    const board = D.addView(doc, "board");
    const cal = D.addView(doc, "calendar");
    let views = D.readViews(doc);
    assert.deepEqual(views.map((v) => v.type), ["table", "board", "calendar"]);
    assert.equal(views[1].groupBy.prop, st);
    assert.equal(views[2].dateProp, due);
    D.updateView(doc, board, { name: "My board", cardSize: "large", sorts: [{ id: "s", prop: st, dir: "desc" }] });
    const v = D.readViews(doc).find((x) => x.id === board);
    assert.equal(v.name, "My board");
    assert.equal(v.cardSize, "large");
    assert.equal(v.sorts[0].dir, "desc");
    D.setViewProp(doc, board, st, { visible: true, width: 300 });
    D.setViewProp(doc, board, st, { width: 320 });
    D.setCalc(doc, board, st, "count");
    D.setGroupState(doc, board, "k", { hidden: true });
    D.setGroupState(doc, board, "k", { collapsed: true });
    const dup = D.duplicateView(doc, board);
    const d = D.readViews(doc).find((x) => x.id === dup);
    assert.equal(d.name, "My board (copy)");
    assert.equal(d.type, "board");
    assert.equal(d.cardSize, "large");
    assert.deepEqual(d.props[st], { visible: true, width: 320 });
    assert.equal(d.calcs[st], "count");
    assert.deepEqual(d.groups.k, { hidden: true, collapsed: true });
    views = D.readViews(doc);
    assert.equal(views[views.findIndex((x) => x.id === board) + 1].id, dup);
    D.setCalc(doc, dup, st, "none");
    assert.equal(D.readViews(doc).find((x) => x.id === dup).calcs[st], undefined);
    assert.equal(D.readViews(doc).find((x) => x.id === board).calcs[st], "count");
    D.moveView(doc, cal, null);
    assert.equal(D.readViews(doc)[0].id, cal);
    D.moveView(doc, cal, dup);
    assert.equal(D.readViews(doc).at(-1).id, cal);
    D.deleteView(doc, board);
    assert.ok(!D.readViews(doc).some((x) => x.id === board));
    D.renameView(doc, cal, "Cal");
    assert.equal(D.readViews(doc).find((x) => x.id === cal).name, "Cal");
  });

  test("readViews dedupes duplicate ids and ignores junk", () => {
    const { doc } = setup();
    const extra = new Y.Map();
    extra.set("id", D.DEFAULT_VIEW);
    extra.set("type", "board");
    D.viewsOf(doc).push([extra]);
    const noId = new Y.Map();
    noId.set("type", "table");
    D.viewsOf(doc).push([noId]);
    const views = D.readViews(doc);
    assert.equal(views.length, 1);
    assert.equal(views[0].type, "table");
  });

  test("view properties order and visibility", () => {
    const { doc } = setup();
    const a = D.addProperty(doc, { type: "text", name: "A" });
    const b = D.addProperty(doc, { type: "text", name: "B" });
    const board = D.addView(doc, "board");
    let view = D.readViews(doc).find((v) => v.id === board);
    const schema = D.readSchema(doc);
    assert.equal(D.isVisible(view, prop(doc, a)), false);
    assert.equal(D.isVisible(D.readViews(doc)[0], prop(doc, a)), true);
    D.moveViewProp(doc, view, schema, b, null);
    view = D.readViews(doc).find((v) => v.id === board);
    assert.equal(D.viewProperties(view, schema)[0].id, b);
    const table = D.readViews(doc)[0];
    D.moveViewProp(doc, table, schema, a, b);
    const ordered = D.viewProperties(D.readViews(doc)[0], schema).map((p) => p.id);
    assert.equal(ordered[0], D.TITLE);
    assert.ok(ordered.indexOf(b) < ordered.indexOf(a));
  });
});

function seedRows() {
  const env = setup();
  const { tree, dbId, doc } = env;
  const num = D.addProperty(doc, { type: "number", name: "Points" });
  const txt = D.addProperty(doc, { type: "text", name: "Notes" });
  const sel = D.addProperty(doc, { type: "select", name: "Kind" });
  const st = D.addProperty(doc, { type: "status", name: "Status" });
  const due = D.addProperty(doc, { type: "date", name: "Due" });
  const chk = D.addProperty(doc, { type: "checkbox", name: "Done" });
  const ppl = D.addProperty(doc, { type: "person", name: "Owner" });
  const files = D.addProperty(doc, { type: "files", name: "Files" });
  const bug = D.addOption(doc, sel, "Bug");
  const feat = D.addOption(doc, sel, "Feature");
  const red = D.addOption(doc, D.DEFAULT_TAGS, "red");
  const blue = D.addOption(doc, D.DEFAULT_TAGS, "blue");
  const sts = prop(doc, st).options;
  const mk = (title, props) => D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title, props });
  const r1 = mk("Alpha", { [num]: 5, [txt]: "hello world", [sel]: bug, [st]: sts[0].id, [due]: { start: "2026-11-23" }, [chk]: true, [ppl]: ["u1"], [D.DEFAULT_TAGS]: [red], [files]: [{ ref: "file:a", name: "cat.png", type: "image/png" }] });
  const r2 = mk("beta", { [num]: 12, [txt]: "Bye", [sel]: feat, [st]: sts[2].id, [due]: { start: "2026-11-20", end: "2026-11-25" }, [ppl]: ["u1", "u2"], [D.DEFAULT_TAGS]: [red, blue] });
  const r3 = mk("Gamma", { [num]: -1, [sel]: bug, [due]: { start: "2026-12-31T09:30" }, [D.DEFAULT_TAGS]: [blue] });
  const r4 = mk("", {});
  const people = new Map([
    ["u1", { id: "u1", name: "Ann", color: "#f00" }],
    ["u2", { id: "u2", name: "Bob", color: "#0f0" }],
  ]);
  return { ...env, num, txt, sel, st, due, chk, ppl, files, bug, feat, red, blue, sts, r1, r2, r3, r4, people, ctx: () => ctxOf(tree, dbId, doc, { people }) };
}

const filterTitles = (s, g) => {
  const ctx = s.ctx();
  return titles(ctx.rows.filter((r) => D.matchFilter(ctx, r, g)));
};
const one = (s, r) => filterTitles(s, group("and", [r]));

describe("filters", () => {
  test("text conditions", () => {
    const s = seedRows();
    assert.deepEqual(one(s, rule(s.txt, "is", "BYE")), ["beta"]);
    assert.deepEqual(one(s, rule(s.txt, "is_not", "bye")), ["Alpha", "Gamma", ""]);
    assert.deepEqual(one(s, rule(s.txt, "contains", "o")), ["Alpha"]);
    assert.deepEqual(one(s, rule(s.txt, "not_contains", "world")), ["beta", "Gamma", ""]);
    assert.deepEqual(one(s, rule(s.txt, "starts", "hel")), ["Alpha"]);
    assert.deepEqual(one(s, rule(s.txt, "ends", "ye")), ["beta"]);
    assert.deepEqual(one(s, rule(s.txt, "empty")), ["Gamma", ""]);
    assert.deepEqual(one(s, rule(s.txt, "not_empty")), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(D.TITLE, "contains", "a")), ["Alpha", "beta", "Gamma"]);
    assert.deepEqual(one(s, rule(D.TITLE, "empty")), [""]);
  });

  test("number conditions", () => {
    const s = seedRows();
    assert.deepEqual(one(s, rule(s.num, "eq", 5)), ["Alpha"]);
    assert.deepEqual(one(s, rule(s.num, "neq", "5")), ["beta", "Gamma", ""]);
    assert.deepEqual(one(s, rule(s.num, "gt", 0)), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.num, "lt", 5)), ["Gamma"]);
    assert.deepEqual(one(s, rule(s.num, "gte", 5)), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.num, "lte", 5)), ["Alpha", "Gamma"]);
    assert.deepEqual(one(s, rule(s.num, "empty")), [""]);
    assert.deepEqual(one(s, rule(s.num, "gt", "abc")).length, 4);
  });

  test("select, status, multi, person, files, checkbox", () => {
    const s = seedRows();
    assert.deepEqual(one(s, rule(s.sel, "is", [s.bug])), ["Alpha", "Gamma"]);
    assert.deepEqual(one(s, rule(s.sel, "is", s.feat)), ["beta"]);
    assert.deepEqual(one(s, rule(s.sel, "is_not", [s.bug])), ["beta", ""]);
    assert.deepEqual(one(s, rule(s.sel, "empty")), [""]);
    assert.deepEqual(one(s, rule(s.st, "is", [s.sts[2].id])), ["beta"]);
    assert.deepEqual(one(s, rule(D.DEFAULT_TAGS, "contains", [s.blue])), ["beta", "Gamma"]);
    assert.deepEqual(one(s, rule(D.DEFAULT_TAGS, "not_contains", [s.blue])), ["Alpha", ""]);
    assert.deepEqual(one(s, rule(D.DEFAULT_TAGS, "empty")), [""]);
    assert.deepEqual(one(s, rule(s.ppl, "contains", ["u2"])), ["beta"]);
    assert.deepEqual(one(s, rule(s.ppl, "not_empty")), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.files, "contains", ["CAT"])), ["Alpha"]);
    assert.deepEqual(one(s, rule(s.files, "empty")), ["beta", "Gamma", ""]);
    assert.deepEqual(one(s, rule(s.chk, "checked")), ["Alpha"]);
    assert.deepEqual(one(s, rule(s.chk, "unchecked")), ["beta", "Gamma", ""]);
    assert.deepEqual(one(s, rule(s.chk, "empty")), ["beta", "Gamma", ""]);
  });

  test("date conditions incl. ranges, relative and between", () => {
    const s = seedRows();
    assert.deepEqual(one(s, rule(s.due, "is", { date: "2026-11-23" })), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "is", "2026-11-23")), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "before", { date: "2026-11-23" })), ["beta"]);
    assert.deepEqual(one(s, rule(s.due, "after", { date: "2026-11-23" })), ["Gamma"]);
    assert.deepEqual(one(s, rule(s.due, "on_or_before", { date: "2026-11-23" })), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "on_or_after", { date: "2026-11-24" })), ["beta", "Gamma"]);
    assert.deepEqual(one(s, rule(s.due, "between", { start: { date: "2026-12-01" }, end: { date: "2026-12-31" } })), ["Gamma"]);
    assert.deepEqual(one(s, rule(s.due, "relative", { relative: "today" })), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "relative", { relative: "past_week" })), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "relative", { relative: "next_month" })), ["Alpha", "beta"]);
    assert.deepEqual(one(s, rule(s.due, "relative", { relative: "this_year" })), ["Alpha", "beta", "Gamma"]);
    assert.deepEqual(one(s, rule(s.due, "relative", { relative: "tomorrow" })), ["beta"]);
    assert.deepEqual(one(s, rule(s.due, "empty")), [""]);
    assert.deepEqual(one(s, rule(s.due, "is", { date: "garbage" })).length, 4);
  });

  test("AND/OR nested groups and inactive rules", () => {
    const s = seedRows();
    const g = group("or", [rule(s.num, "gt", 10), group("and", [rule(s.sel, "is", [s.bug]), rule(s.chk, "checked")])]);
    assert.deepEqual(filterTitles(s, g), ["Alpha", "beta"]);
    assert.deepEqual(filterTitles(s, group("and", [rule(s.num, "gt", 0), rule(s.txt, "contains", "")])), ["Alpha", "beta"]);
    assert.deepEqual(filterTitles(s, group("or", [rule(s.txt, "contains", ""), rule(s.sel, "is", [])])).length, 4);
    assert.deepEqual(filterTitles(s, group("and", [rule("missing", "is", "x")])).length, 4);
    assert.deepEqual(filterTitles(s, group("or", [group("and", [])])).length, 4);
    assert.equal(D.countFilterRules(g), 3);
  });

  test("cleanFilter survives hostile JSON", () => {
    let deep = { kind: "group", op: "and", rules: [] };
    for (let i = 0; i < 5000; i++) deep = { kind: "group", op: "or", rules: [deep] };
    const c = D.cleanFilter(deep);
    let depth = 0;
    let node = c;
    while (node.rules[0]?.kind === "group") {
      node = node.rules[0];
      depth++;
    }
    assert.ok(depth <= 4);
    const huge = { op: "and", rules: Array.from({ length: 100000 }, (_, i) => ({ prop: "p", cond: "is", value: i })) };
    assert.ok(D.cleanFilter(huge).rules.length <= 202);
    assert.equal(D.cleanFilter(null).rules.length, 0);
    assert.equal(D.cleanFilter("x").rules.length, 0);
    assert.equal(D.cleanFilter({ rules: "nope" }).rules.length, 0);
    const mixed = D.cleanFilter({ op: "xor", id: 5, rules: [null, 1, "s", { prop: 1 }, { prop: "a", cond: "is" }, { kind: "group", rules: {} }] });
    assert.equal(mixed.op, "and");
    assert.equal(mixed.id, "root");
    assert.equal(mixed.rules.length, 2);
    const host = new Y.Doc();
    const view = new Y.Map();
    host.getArray("views").push([view]);
    view.set("id", "v");
    view.set("filter", deep);
    view.set("sorts", [null, { prop: 5 }, { prop: "a", dir: "weird" }]);
    const r = D.readView(view);
    assert.ok(r.filter.rules.length <= 1);
    assert.equal(r.sorts.length, 1);
    assert.equal(r.sorts[0].dir, "asc");
  });
});

describe("sorts and search", () => {
  test("multiple keys, desc, empties last, select by option order", () => {
    const s = seedRows();
    const ctx = s.ctx();
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: s.num, dir: "asc" }])), ["Gamma", "Alpha", "beta", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: s.num, dir: "desc" }])), ["beta", "Alpha", "Gamma", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: D.TITLE, dir: "asc" }])), ["Alpha", "beta", "Gamma", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: s.sel, dir: "asc" }, { id: "b", prop: s.num, dir: "desc" }])), ["Alpha", "Gamma", "beta", ""]);
    D.moveOption(s.doc, s.sel, s.feat, null);
    const ctx2 = s.ctx();
    assert.deepEqual(titles(D.sortRows(ctx2, ctx2.rows, [{ id: "a", prop: s.sel, dir: "asc" }])), ["beta", "Alpha", "Gamma", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: s.due, dir: "asc" }])), ["beta", "Alpha", "Gamma", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: s.chk, dir: "desc" }])), ["Alpha", "beta", "Gamma", ""]);
    assert.deepEqual(titles(D.sortRows(ctx, ctx.rows, [{ id: "a", prop: "missing", dir: "desc" }])), ["Alpha", "beta", "Gamma", ""]);
  });

  test("search matches title, text and option names", () => {
    const s = seedRows();
    const ctx = s.ctx();
    const find = (q) => titles(ctx.rows.filter((r) => D.matchSearch(ctx, r, q)));
    assert.deepEqual(find("gam"), ["Gamma"]);
    assert.deepEqual(find("WORLD"), ["Alpha"]);
    assert.deepEqual(find("feature"), ["beta"]);
    assert.equal(find("").length, 4);
  });

  test("a new row's prefill satisfies nested filters and keeps the lane's value", () => {
    const s = seedRows();
    const ctx = s.ctx();
    const filter = group("and", [rule(s.chk, "unchecked"), group("or", [rule(s.due, "is", { relative: "today" }), rule(s.due, "is", { relative: "tomorrow" })]), group("or", [rule(s.st, "is_not", [s.sts[2].id]), rule(s.num, "gt", 3)]), rule(s.sel, "is", [s.feat])]);
    const props = D.prefillForFilter(ctx, filter, { [s.sel]: s.bug });
    assert.equal(props[s.sel], s.bug);
    assert.equal(props[s.chk], undefined);
    assert.match(props[s.due].start, /^\d{4}-\d{2}-\d{2}$/);
    const row = { ...ctx.rows[3], props };
    assert.equal(D.matchFilter(ctx, row, group("and", filter.rules.slice(0, 3))), true);
    const later = D.prefillForFilter(ctx, group("and", [rule(s.num, "gt", 10), rule(s.txt, "contains", "plan"), rule(s.ppl, "contains", ["u2"]), rule(s.due, "after", { relative: "today" })]));
    assert.deepEqual([later[s.num], later[s.txt], later[s.ppl]], [11, "plan", ["u2"]]);
    assert.equal(D.matchRule(ctx, { ...ctx.rows[3], props: later }, rule(s.due, "after", { relative: "today" })), true);
  });

  test("computeView keeps rows it was told to keep", () => {
    const s = seedRows();
    const v = D.addView(s.doc, "table", { init: { filter: group("and", [rule(s.num, "gt", 100)]) } });
    const view = D.readViews(s.doc).find((x) => x.id === v);
    assert.deepEqual(titles(D.computeView(s.ctx(), view).rows), []);
    assert.deepEqual(titles(D.computeView(s.ctx(), view, "", new Set([s.r3])).rows), ["Gamma"]);
  });

  test("computeView filters, sorts and groups", () => {
    const s = seedRows();
    const v = D.addView(s.doc, "board", { init: { groupBy: { prop: s.sel }, filter: group("and", [rule(s.num, "gt", 0)]), sorts: [{ id: "x", prop: s.num, dir: "desc" }] } });
    const view = D.readViews(s.doc).find((x) => x.id === v);
    const res = D.computeView(s.ctx(), view);
    assert.deepEqual(titles(res.rows), ["beta", "Alpha"]);
    assert.deepEqual(res.groups.map((g) => [g.key, g.rows.length]), [[D.NONE, 0], [s.bug, 1], [s.feat, 1]]);
    assert.deepEqual(titles(D.computeView(s.ctx(), view, "alp").rows), ["Alpha"]);
  });
});

describe("grouping", () => {
  const by = (p, extra = {}) => ({ prop: p, date: "relative", text: "exact", status: "option", step: 10, sort: "manual", hideEmpty: false, ...extra });
  const summary = (groups) => groups.map((g) => [g.label, titles(g.rows)]);

  test("select with empty group first", () => {
    const s = seedRows();
    const ctx = s.ctx();
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.sel), {})), [["No Kind", [""]], ["Bug", ["Alpha", "Gamma"]], ["Feature", ["beta"]]]);
  });

  test("status by option and by group", () => {
    const s = seedRows();
    const ctx = s.ctx();
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.st), {})).map((g) => g[0]), ["No Status", "Not started", "In progress", "Done"]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.st, { status: "group" }), {})), [["No Status", ["Gamma", ""]], ["To-do", ["Alpha"]], ["In progress", []], ["Complete", ["beta"]]]);
  });

  test("multi-select puts a row in each group; person and checkbox", () => {
    const s = seedRows();
    const ctx = s.ctx();
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(D.DEFAULT_TAGS), {})), [["No Tags", [""]], ["red", ["Alpha", "beta"]], ["blue", ["beta", "Gamma"]]]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.ppl), {})), [["No Owner", ["Gamma", ""]], ["Ann", ["Alpha", "beta"]], ["Bob", ["beta"]]]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.chk), {})), [["Unchecked", ["beta", "Gamma", ""]], ["Checked", ["Alpha"]], ["No Done", []]]);
  });

  test("date buckets and number steps and text alpha", () => {
    const s = seedRows();
    const ctx = s.ctx();
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.due, { date: "month" }), {})), [["November 2026", ["Alpha", "beta"]], ["December 2026", ["Gamma"]], ["No Due", [""]]]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.due, { date: "relative" }), {})).map((g) => g[0]), ["Last 7 days", "Today", "December 2026", "No Due"]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.due, { date: "year" }), {})).map((g) => g[0]), ["2026", "No Due"]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.due, { date: "day" }), {})).map((g) => g[0]), ["November 20, 2026", "November 23, 2026", "December 31, 2026", "No Due"]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(s.num, { step: 10 }), {})), [["-10 to 0", ["Gamma"]], ["0 to 10", ["Alpha"]], ["10 to 20", ["beta"]], ["No Points", [""]]]);
    assert.deepEqual(summary(D.groupRows(ctx, ctx.rows, by(D.TITLE, { text: "alpha" }), {})), [["A", ["Alpha"]], ["B", ["beta"]], ["G", ["Gamma"]], ["No Name", [""]]]);
  });

  test("hidden, hideEmpty, collapsed, sort and manual order", () => {
    const s = seedRows();
    const ctx = s.ctx();
    const g1 = D.groupRows(ctx, ctx.rows, by(s.st, { hideEmpty: true }), { [s.sts[0].id]: { collapsed: true } });
    assert.deepEqual(g1.filter((g) => !g.hidden).map((g) => g.label), ["No Status", "Not started", "Done"]);
    assert.equal(g1.find((g) => g.label === "Not started").collapsed, true);
    const g2 = D.groupRows(ctx, ctx.rows, by(s.sel), { [s.bug]: { hidden: true } });
    assert.equal(g2.find((g) => g.key === s.bug).hidden, true);
    const g3 = D.groupRows(ctx, ctx.rows, by(s.sel, { sort: "desc" }), {});
    assert.deepEqual(g3.map((g) => g.label), ["No Kind", "Feature", "Bug"]);
    const g4 = D.groupRows(ctx, ctx.rows, by(s.sel), { [s.feat]: { order: "0" }, [s.bug]: { order: "5" } });
    assert.deepEqual(g4.filter((g) => !g.empty).map((g) => g.label), ["Feature", "Bug"]);
  });

  test("moveToGroupValue for select, multi, person, checkbox and date ranges", () => {
    const s = seedRows();
    const ctx = s.ctx();
    const r2 = M.getPage(s.tree, s.r2);
    assert.equal(D.moveToGroupValue(ctx, r2, prop(s.doc, s.sel), s.feat, s.bug), s.bug);
    assert.equal(D.moveToGroupValue(ctx, r2, prop(s.doc, s.sel), s.feat, D.NONE), null);
    assert.deepEqual(D.moveToGroupValue(ctx, r2, prop(s.doc, D.DEFAULT_TAGS), s.red, "green"), [s.blue, "green"]);
    assert.deepEqual(D.moveToGroupValue(ctx, r2, prop(s.doc, D.DEFAULT_TAGS), s.red, s.blue), [s.blue]);
    assert.deepEqual(D.moveToGroupValue(ctx, r2, prop(s.doc, s.ppl), "u2", "u3"), ["u1", "u3"]);
    assert.deepEqual(D.moveToGroupValue(ctx, r2, prop(s.doc, s.ppl), "u2", D.NONE), []);
    assert.equal(D.moveToGroupValue(ctx, r2, prop(s.doc, s.chk), "false", "true"), true);
    assert.deepEqual(D.moveToGroupValue(ctx, r2, prop(s.doc, s.due), "", "2026-12-01"), { start: "2026-12-01", end: "2026-12-06" });
    assert.deepEqual(D.moveToGroupValue(ctx, M.getPage(s.tree, s.r1), prop(s.doc, s.due), "", "m:2027-02"), { start: "2027-02-01" });
    assert.equal(D.groupValueFor(ctx, prop(s.doc, s.st), "done"), s.sts[2].id);
  });
});

describe("calculations", () => {
  test("every calc fn", () => {
    const s = seedRows();
    const ctx = s.ctx();
    const calc = (p, fn) => D.calculate(ctx, ctx.rows, prop(s.doc, p), fn);
    assert.equal(calc(s.num, "none"), "");
    assert.equal(calc(s.num, "count"), "4");
    assert.equal(calc(s.num, "count_values"), "3");
    assert.equal(calc(s.sel, "unique"), "2");
    assert.equal(calc(s.num, "empty"), "1");
    assert.equal(calc(s.num, "not_empty"), "3");
    assert.equal(calc(s.num, "percent_empty"), "25%");
    assert.equal(calc(s.num, "percent_not_empty"), "75%");
    assert.equal(calc(s.chk, "checked"), "1");
    assert.equal(calc(s.chk, "unchecked"), "3");
    assert.equal(calc(s.chk, "percent_checked"), "25%");
    assert.equal(calc(s.chk, "percent_unchecked"), "75%");
    assert.equal(calc(s.num, "sum"), "16");
    assert.equal(calc(s.num, "avg"), "5.33");
    assert.equal(calc(s.num, "median"), "5");
    assert.equal(calc(s.num, "min"), "-1");
    assert.equal(calc(s.num, "max"), "12");
    assert.equal(calc(s.num, "range"), "13");
    assert.equal(calc(s.due, "earliest"), "November 20, 2026");
    assert.match(calc(s.due, "latest"), /December 31, 2026/);
    assert.equal(calc(s.due, "date_range"), "41 days");
    assert.equal(calc(D.DEFAULT_TAGS, "unique"), "2");
    D.updateProperty(s.doc, s.num, { format: "dollar" });
    const ctx2 = s.ctx();
    assert.equal(D.calculate(ctx2, ctx2.rows, prop(s.doc, s.num), "sum"), "$16.00");
    assert.equal(D.calculate(ctx2, [], prop(s.doc, s.num), "percent_empty"), "0%");
    assert.equal(D.calculate(ctx2, [], prop(s.doc, s.num), "avg"), "");
    assert.ok(D.calcsFor("number").includes("median"));
    assert.ok(D.calcsFor("date").includes("date_range"));
    assert.ok(!D.calcsFor("checkbox").includes("sum"));
  });

  test("formatNumber", () => {
    assert.equal(D.formatNumber(1234.5, "commas"), "1,234.5");
    assert.equal(D.formatNumber(0.256, "percent"), "25.6%");
    assert.equal(D.formatNumber(1000, "yen"), "¥1,000");
    assert.equal(D.formatNumber(0.1 + 0.2, "number"), "0.3");
    assert.equal(D.formatNumber(null), "");
    assert.equal(D.formatNumber(NaN), "");
  });
});

describe("formulas", () => {
  const ev = (s, expr, row = s.r1) => D.evaluateFormula(s.ctx(), M.getPage(s.tree, row), expr);

  test("arithmetic and precedence", () => {
    const s = seedRows();
    assert.equal(ev(s, "1 + 2 * 3"), 7);
    assert.equal(ev(s, "(1 + 2) * 3"), 9);
    assert.equal(ev(s, "2 ^ 3 ^ 2"), 512);
    assert.equal(ev(s, "-2 ^ 2"), 4);
    assert.equal(ev(s, "10 - 4 - 3"), 3);
    assert.equal(ev(s, "8 / 4 / 2"), 1);
    assert.equal(ev(s, "7 % 4"), 3);
    assert.equal(ev(s, "1 / 0"), null);
    assert.equal(ev(s, "1.5e2 + .5"), 150.5);
    assert.equal(ev(s, '"a" + 1'), "a1");
  });

  test("comparisons and logic", () => {
    const s = seedRows();
    assert.equal(ev(s, "1 < 2 && 2 <= 2"), true);
    assert.equal(ev(s, "1 == 1 and 2 != 3"), true);
    assert.equal(ev(s, "false or not false"), true);
    assert.equal(ev(s, "!true || 3 > 4"), false);
    assert.equal(ev(s, '"b" > "a"'), true);
    assert.equal(ev(s, "1 == \"1\""), false);
    assert.equal(ev(s, "if(1 > 2, \"y\", \"n\")"), "n");
    assert.equal(ev(s, "ifs(false, 1, true, 2, 3)"), 2);
    assert.equal(ev(s, "ifs(false, 1, 9)"), 9);
    assert.equal(ev(s, "true ? 1 : 2"), 1);
    assert.equal(ev(s, "and(true, 1, \"x\")"), true);
    assert.equal(ev(s, "or(false, 0)"), false);
    assert.equal(ev(s, "not(0)"), true);
    assert.ok(D.isError(ev(s, "[1] < 2")));
  });

  test("text functions", () => {
    const s = seedRows();
    assert.equal(ev(s, 'concat("a", "b", 3)'), "ab3");
    assert.deepEqual(ev(s, "concat([1], [2, 3])"), [1, 2, 3]);
    assert.equal(ev(s, "format(12)"), "12");
    assert.equal(ev(s, 'length("hello")'), 5);
    assert.equal(ev(s, 'contains("hello", "ell")'), true);
    assert.equal(ev(s, 'replace("a-b-c", "-", "+")'), "a+b-c");
    assert.equal(ev(s, 'replaceAll("a-b-c", "-", "+")'), "a+b+c");
    assert.equal(ev(s, 'replace("a$b", "$", "$&$&")'), "a$&$&b");
    assert.equal(ev(s, 'upper("x") + lower("Y") + trim("  z ")'), "Xyz");
    assert.equal(ev(s, 'join(["a", "b"], ", ")'), "a, b");
    assert.deepEqual(ev(s, 'split("a,b", ",")'), ["a", "b"]);
    assert.equal(ev(s, '"it\\"s"'), 'it"s');
    assert.equal(ev(s, "toNumber(\"42\") + 1"), 43);
  });

  test("math functions", () => {
    const s = seedRows();
    assert.equal(ev(s, "round(3.14159, 2)"), 3.14);
    assert.equal(ev(s, "round(2.5)"), 3);
    assert.equal(ev(s, "abs(-3)"), 3);
    assert.equal(ev(s, "min(3, 1, 2)"), 1);
    assert.equal(ev(s, "max([3, 9], 2)"), 9);
    assert.equal(ev(s, "sum([1, 2, 3])"), 6);
    assert.equal(ev(s, "mean(1, 2, 3, 4)"), 2.5);
    assert.equal(ev(s, "median([5, 1, 3])"), 3);
    assert.equal(ev(s, "sqrt(16) + pow(2, 3) + mod(7, 3)"), 13);
    assert.equal(ev(s, "floor(1.9) + ceil(1.1)"), 3);
    assert.equal(ev(s, "sqrt(-1)"), null);
    assert.ok(Math.abs(ev(s, "pi") - Math.PI) < 1e-12);
  });

  test("dates", () => {
    const s = seedRows();
    const now = s.ctx().now;
    assert.equal(ev(s, "now()").start, now);
    assert.equal(ev(s, 'formatDate(dateAdd(prop("Due"), 1, "months"), "YYYY-MM-DD")'), "2026-12-23");
    assert.equal(ev(s, 'formatDate(dateSubtract(prop("Due"), 1, "day"), "MMM D, YYYY")'), "Nov 22, 2026");
    assert.equal(ev(s, 'dateBetween(dateAdd(prop("Due"), 10, "days"), prop("Due"), "days")'), 10);
    assert.equal(ev(s, 'dateBetween(parseDate("2027-01-31"), parseDate("2026-01-31"), "years")'), 1);
    assert.equal(ev(s, 'dateBetween(parseDate("2026-03-01"), parseDate("2026-01-31"), "months")'), 1);
    assert.equal(ev(s, 'year(prop("Due")) * 100 + month(prop("Due"))'), 202611);
    assert.equal(ev(s, 'formatDate(dateEnd(prop("Due")), "D")', s.r2), "25");
    assert.equal(ev(s, 'formatDate(prop("Due"), "h:mm A")', s.r3), "9:30 AM");
    assert.ok(D.isError(ev(s, 'dateAdd(prop("Due"), 1, "fortnights")')));
    assert.ok(D.isError(ev(s, 'dateAdd(prop("Due"), 1e12, "days")')));
    assert.ok(D.isError(ev(s, 'dateAdd("x", 1, "days")')));
  });

  test("lists, map, filter, let and method calls", () => {
    const s = seedRows();
    assert.deepEqual(ev(s, "map([1, 2, 3], current * 2)"), [2, 4, 6]);
    assert.deepEqual(ev(s, "filter([1, 2, 3, 4], current % 2 == 0)"), [2, 4]);
    assert.deepEqual(ev(s, "[1, 2, 3].map(current + index)"), [1, 3, 5]);
    assert.equal(ev(s, "find([1, 5, 9], current > 3)"), 5);
    assert.equal(ev(s, "some([1, 2], current > 1) and every([1, 2], current > 0)"), true);
    assert.equal(ev(s, "let(x, 4, x * x)"), 16);
    assert.equal(ev(s, 'prop("Notes").length()'), 11);
    assert.equal(ev(s, 'prop("Notes").upper().slice(0, 5)'), "HELLO");
    assert.equal(ev(s, "[3, 1, 2].sort().first()"), 1);
    assert.equal(ev(s, "[1, 2, 3].at(-1)"), 3);
    assert.deepEqual(ev(s, "unique([1, 1, 2])"), [1, 2]);
    assert.ok(D.isError(ev(s, "current")));
  });

  test("prop refs across types", () => {
    const s = seedRows();
    assert.equal(ev(s, 'prop("Points") * 2'), 10);
    assert.equal(ev(s, 'prop("Kind")'), "Bug");
    assert.deepEqual(ev(s, 'prop("Tags")', s.r2), ["red", "blue"]);
    assert.equal(ev(s, 'prop("Done")'), true);
    assert.equal(ev(s, 'prop("Name")'), "Alpha");
    assert.equal(ev(s, 'prop("Owner").map(name(current)).join(",")', s.r2), "Ann,Bob");
    assert.equal(ev(s, 'empty(prop("Points"))', s.r4), true);
    assert.equal(ev(s, 'prop("Points") + 1', s.r4), 1);
    assert.ok(D.isError(ev(s, 'prop("Missing")')));
  });

  test("formula referencing formula, and self-reference cycles", () => {
    const s = seedRows();
    const f1 = D.addProperty(s.doc, { type: "formula", name: "Double", expression: 'prop("Points") * 2' });
    const f2 = D.addProperty(s.doc, { type: "formula", name: "Quad", expression: 'prop("Double") * 2' });
    const self = D.addProperty(s.doc, { type: "formula", name: "Self", expression: 'prop("Self") + 1' });
    const a = D.addProperty(s.doc, { type: "formula", name: "A", expression: 'prop("B")' });
    D.addProperty(s.doc, { type: "formula", name: "B", expression: 'prop("A")' });
    const ctx = s.ctx();
    const r1 = M.getPage(s.tree, s.r1);
    assert.equal(D.fvalue(ctx, r1, prop(s.doc, f1)), 10);
    assert.equal(D.fvalue(ctx, r1, prop(s.doc, f2)), 20);
    assert.ok(D.isError(D.fvalue(ctx, r1, prop(s.doc, self))));
    assert.ok(D.isError(D.fvalue(ctx, r1, prop(s.doc, a))));
    assert.equal(D.kindOf(ctx, prop(s.doc, f1)), "number");
    const sorted = D.sortRows(ctx, ctx.rows, [{ id: "x", prop: f2, dir: "desc" }]);
    assert.deepEqual(titles(sorted), ["beta", "Alpha", "", "Gamma"]);
    assert.deepEqual(one(s, rule(f2, "gt", 15)), ["Alpha", "beta"]);
  });

  test("hostile input never throws or hangs", () => {
    const s = seedRows();
    const hostile = [
      "1+".repeat(3000) + "1",
      "(".repeat(10000) + "1" + ")".repeat(10000),
      "[".repeat(10000),
      "-".repeat(10000) + "1",
      "!".repeat(10000) + "true",
      'prop("__proto__")',
      'prop("constructor")',
      "__proto__",
      "constructor",
      "constructor()",
      "__proto__()",
      "toString()",
      "hasOwnProperty(1)",
      "valueOf()",
      '"x".constructor()',
      'repeat("x", 1e9)',
      'repeat(repeat("x", 10000), 10000)',
      'map(split(repeat("a,", 1999), ","), map(split(repeat("a,", 1999), ","), current))',
      "map([" + Array(1500).fill("1").join(",") + "], [" + Array(1500).fill("1").join(",") + "])",
      '"unterminated',
      "'also",
      "1 +",
      "if(",
      "if(1)",
      ")",
      "1 2",
      "@",
      "😀 + 1",
      '"héllo 😀".length()',
      "let(1, 2, 3)",
      "fromTimestamp(1e300)",
      "2 ^ 99999",
      "padStart(\"a\", 1e9, \"b\")",
      "split(\"\", \"\")",
      "x".repeat(5000),
      "concat(" + Array(60).fill('"a"').join(",") + ")",
      "\u0000",
      "1.2.3",
      "..",
      "[1,2].",
      "[1,2].foo()",
    ];
    for (const expr of hostile) {
      const start = Date.now();
      let out;
      assert.doesNotThrow(() => {
        out = ev(s, expr);
      }, expr.slice(0, 40));
      assert.ok(Date.now() - start < 2000, `slow: ${expr.slice(0, 40)}`);
      assert.ok(out === null || ["number", "string", "boolean", "object"].includes(typeof out), expr.slice(0, 40));
      if (typeof out === "string") assert.ok(out.length <= 20000);
    }
    assert.ok(D.isError(ev(s, "x".repeat(5000))));
    assert.ok(D.isError(ev(s, '"unterminated')));
    assert.ok(D.isError(ev(s, "__proto__()")));
    assert.ok(D.isError(ev(s, 'prop("__proto__")')));
    assert.equal(ev(s, '"héllo 😀".length()'), 8);
    assert.equal(ev(s, ""), null);
  });
});

describe("relations and rollups", () => {
  function twoDbs() {
    const tree = new Y.Doc();
    const projects = M.createPage(tree, { parent: "", kind: "database", title: "Projects", by: BY });
    const tasks = M.createPage(tree, { parent: "", kind: "database", title: "Tasks", by: BY });
    const pDoc = new Y.Doc();
    const tDoc = new Y.Doc();
    D.initDatabase(pDoc);
    D.initDatabase(tDoc);
    const pts = D.addProperty(tDoc, { type: "number", name: "Points" });
    const done = D.addProperty(tDoc, { type: "checkbox", name: "Done" });
    const due = D.addProperty(tDoc, { type: "date", name: "Due" });
    const rel = D.addRelationProperty(pDoc, { name: "Tasks", target: tasks, source: projects, twoWay: true, targetDoc: tDoc, sourceName: "Projects" });
    const back = prop(pDoc, rel).backProp;
    const t = (title, props) => D.createRow(tree, tasks, D.readSchema(tDoc), { by: BY, title, props });
    const t1 = t("T1", { [pts]: 3, [done]: true, [due]: { start: "2026-05-02" } });
    const t2 = t("T2", { [pts]: 5, [due]: { start: "2026-04-01" } });
    const t3 = t("T3", { [pts]: 100 });
    const p1 = D.createRow(tree, projects, D.readSchema(pDoc), { by: BY, title: "P1" });
    const p2 = D.createRow(tree, projects, D.readSchema(pDoc), { by: BY, title: "P2" });
    const docs = { [projects]: pDoc, [tasks]: tDoc };
    const ctx = () => ctxOf(tree, projects, pDoc, { docs });
    return { tree, projects, tasks, pDoc, tDoc, pts, done, due, rel, back, t1, t2, t3, p1, p2, ctx };
  }

  test("rows land in their own database", () => {
    const r = twoDbs();
    assert.deepEqual(titles(D.databaseRows(r.tree, r.tasks)), ["T1", "T2", "T3"]);
    assert.deepEqual(titles(D.databaseRows(r.tree, r.projects)), ["P1", "P2"]);
  });

  test("two-way relation creates a back property and keeps both sides in step", () => {
    const r = twoDbs();
    const back = prop(r.tDoc, r.back);
    assert.equal(back.type, "relation");
    assert.equal(back.relation, r.projects);
    assert.equal(back.backProp, r.rel);
    assert.equal(back.name, "Related to Projects");
    const relProp = prop(r.pDoc, r.rel);
    D.setRelation(r.tree, r.p1, relProp, [r.t1, r.t2], BY);
    assert.deepEqual(M.getPage(r.tree, r.t1).props[r.back], [r.p1]);
    assert.deepEqual(M.getPage(r.tree, r.t2).props[r.back], [r.p1]);
    D.setRelation(r.tree, r.p2, relProp, [r.t1], BY);
    assert.deepEqual(M.getPage(r.tree, r.t1).props[r.back], [r.p1, r.p2]);
    D.setRelation(r.tree, r.p1, relProp, [r.t2], BY);
    assert.deepEqual(M.getPage(r.tree, r.t1).props[r.back], [r.p2]);
    D.setRelation(r.tree, r.t2, prop(r.tDoc, r.back), [], BY);
    assert.deepEqual(M.getPage(r.tree, r.p1).props[r.rel], []);
    D.setRelation(r.tree, r.p1, relProp, [r.t3, r.t3], BY);
    assert.deepEqual(M.getPage(r.tree, r.p1).props[r.rel], [r.t3]);
    D.unlinkBackRelation(r.tDoc, r.back);
    assert.equal(prop(r.tDoc, r.back).twoWay, false);
  });

  test("syncBackRelation fills missing back references", () => {
    const r = twoDbs();
    M.setProp(r.tree, r.p1, r.rel, [r.t3], BY);
    D.syncBackRelation(r.tree, r.projects, prop(r.pDoc, r.rel), BY);
    assert.deepEqual(M.getPage(r.tree, r.t3).props[r.back], [r.p1]);
  });

  test("self relation two-way lives in one doc", () => {
    const { tree, dbId, doc } = setup();
    const rel = D.addRelationProperty(doc, { name: "Parent", target: dbId, source: dbId, twoWay: true });
    const back = prop(doc, rel).backProp;
    assert.equal(prop(doc, back).relation, dbId);
    const a = D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title: "a" });
    const b = D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title: "b" });
    D.setRelation(tree, a, prop(doc, rel), [b], BY);
    assert.deepEqual(M.getPage(tree, b).props[back], [a]);
  });

  test("rollups over relations", () => {
    const r = twoDbs();
    D.setRelation(r.tree, r.p1, prop(r.pDoc, r.rel), [r.t1, r.t2], BY);
    const roll = (fn, target) => {
      const id = D.addProperty(r.pDoc, { type: "rollup", name: `R ${fn} ${target}`, rollupRelation: r.rel, rollupTarget: target, rollupFn: fn });
      return D.fvalue(r.ctx(), M.getPage(r.tree, r.p1), prop(r.pDoc, id));
    };
    assert.equal(roll("count", r.pts), 2);
    assert.equal(roll("sum", r.pts), 8);
    assert.equal(roll("avg", r.pts), 4);
    assert.equal(roll("percent_checked", r.done), 0.5);
    assert.deepEqual(roll("show_original", D.TITLE), ["T1", "T2"]);
    assert.deepEqual(roll("show_original", r.pts), [3, 5]);
    const earliest = roll("earliest", r.due);
    assert.equal(D.toDateString(earliest.start), "2026-04-01");
    assert.equal(roll("date_range", r.due), 31);
    const none = D.addProperty(r.pDoc, { type: "rollup", name: "none", rollupRelation: "missing", rollupTarget: r.pts, rollupFn: "sum" });
    assert.equal(D.fvalue(r.ctx(), M.getPage(r.tree, r.p1), prop(r.pDoc, none)), null);
    M.archivePage(r.tree, r.t2, BY);
    assert.equal(roll("count", r.pts), 1);
    M.deletePage(r.tree, r.t1, BY);
    assert.equal(roll("count", r.pts), 0);
    const rel = D.fvalue(r.ctx(), M.getPage(r.tree, r.p1), prop(r.pDoc, r.rel));
    assert.deepEqual(rel, []);
  });

  test("relation filter and formula over relation", () => {
    const r = twoDbs();
    D.setRelation(r.tree, r.p1, prop(r.pDoc, r.rel), [r.t1], BY);
    const ctx = r.ctx();
    const f = (rl) => titles(ctx.rows.filter((row) => D.matchRule(ctx, row, rl)));
    assert.deepEqual(f(rule(r.rel, "contains", [r.t1])), ["P1"]);
    assert.deepEqual(f(rule(r.rel, "empty")), ["P2"]);
    assert.equal(D.evaluateFormula(ctx, M.getPage(r.tree, r.p1), 'prop("Tasks").length()'), 1);
    assert.equal(D.evaluateFormula(ctx, M.getPage(r.tree, r.p1), 'prop("Tasks").first().id()'), r.t1);
  });
});

describe("rows and cells", () => {
  test("createRow assigns IDs, setCell cleans values", () => {
    const { tree, dbId, doc } = setup();
    const id = D.addProperty(doc, { type: "id", name: "ID", prefix: "T" });
    const n = D.addProperty(doc, { type: "number", name: "N" });
    const dt = D.addProperty(doc, { type: "date", name: "D" });
    const a = D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title: "a" });
    const b = D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title: "b" });
    assert.equal(M.getPage(tree, a).props[id], 1);
    assert.equal(M.getPage(tree, b).props[id], 2);
    M.archivePage(tree, b, BY);
    const c = D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title: "c" });
    assert.equal(M.getPage(tree, c).props[id], 3);
    D.setCell(tree, a, prop(doc, n), "$1,234.5", BY);
    assert.equal(M.getPage(tree, a).props[n], 1234.5);
    D.setCell(tree, a, prop(doc, n), "abc", BY);
    assert.equal(M.getPage(tree, a).props[n], undefined);
    D.setCell(tree, a, prop(doc, dt), { start: "2026-01-01", end: "bad" }, BY);
    assert.deepEqual(M.getPage(tree, a).props[dt], { start: "2026-01-01" });
    D.setCell(tree, a, prop(doc, dt), { start: "2026-13-45" }, BY);
    assert.equal(M.getPage(tree, a).props[dt], undefined);
    D.setCell(tree, a, prop(doc, D.TITLE), "x".repeat(3000), BY);
    assert.equal(M.getPage(tree, a).title.length, 2000);
    D.setCell(tree, a, prop(doc, id), 99, BY);
    assert.equal(M.getPage(tree, a).props[id], 1);
    const tpl = D.createRow(tree, dbId, [], { by: BY, title: "tpl", isTemplate: true });
    assert.ok(!D.databaseRows(tree, dbId).some((r) => r.id === tpl));
    assert.ok(D.databaseRows(tree, dbId, { templates: true }).some((r) => r.id === tpl));
    assert.deepEqual(D.cleanCellValue(prop(doc, D.DEFAULT_TAGS), ["a", 1, null, "b"]), ["a", "b"]);
  });

  test("dates parse strictly and format", () => {
    assert.equal(D.parseDateString("2026-02-30"), null);
    assert.equal(D.parseDateString("2026-01-01T25:00"), null);
    assert.equal(D.parseDateString("2026-01-01T09:05").time, true);
    assert.equal(D.parseDateString("nope"), null);
    assert.equal(D.parseDateString(5), null);
    assert.equal(D.formatDay(new Date(2026, 10, 23).getTime(), "ymd"), "2026/11/23");
    assert.equal(D.formatDay(new Date(2026, 10, 24).getTime(), "relative", new Date(2026, 10, 23).getTime()), "Tomorrow");
    assert.equal(D.formatTime(new Date(2026, 0, 1, 13, 5).getTime(), "24"), "13:05");
    assert.equal(D.formatTime(new Date(2026, 0, 1, 0, 5).getTime(), "12"), "12:05 AM");
    assert.equal(D.toDateString(D.addMonths(new Date(2026, 0, 31).getTime(), 1)), "2026-02-28");
  });
});

describe("retypeProperty", () => {
  test("text to select creates options, select to multi keeps ids, multi to select, number and text, checkbox, id", () => {
    const { tree, dbId, doc } = setup();
    const p = D.addProperty(doc, { type: "text", name: "P" });
    const mk = (title, v, createdAt) => D.createRow(tree, dbId, D.readSchema(doc), { by: BY, title, props: v === undefined ? {} : { [p]: v }, now: createdAt });
    const a = mk("a", "Red", 3000);
    const b = mk("b", "blue", 1000);
    const c = mk("c", "red", 2000);
    const e = mk("e", undefined, 4000);
    D.retypeProperty(doc, tree, dbId, prop(doc, p), "select", BY);
    let sp = prop(doc, p);
    assert.equal(sp.type, "select");
    assert.deepEqual(sp.options.map((o) => o.name).sort(), ["Red", "blue"]);
    const val = (r) => M.getPage(tree, r).props[p];
    assert.equal(val(a), val(c));
    assert.equal(D.optionOf(sp, val(b)).name, "blue");
    assert.equal(val(e), undefined);
    const redId = val(a);
    D.retypeProperty(doc, tree, dbId, prop(doc, p), "multi_select", BY);
    assert.deepEqual(val(a), [redId]);
    assert.deepEqual(val(e), []);
    M.setProp(tree, a, p, [redId, val(b)[0]], BY);
    D.retypeProperty(doc, tree, dbId, prop(doc, p), "select", BY);
    assert.equal(val(a), redId);
    D.retypeProperty(doc, tree, dbId, prop(doc, p), "text", BY);
    assert.equal(val(a), "Red");
    assert.equal(val(b), "blue");

    const n = D.addProperty(doc, { type: "number", name: "N" });
    M.setProp(tree, a, n, 42, BY);
    D.retypeProperty(doc, tree, dbId, prop(doc, n), "text", BY);
    assert.equal(M.getPage(tree, a).props[n], "42");
    M.setProp(tree, b, n, "1,000", BY);
    D.retypeProperty(doc, tree, dbId, prop(doc, n), "number", BY);
    assert.equal(M.getPage(tree, a).props[n], 42);
    assert.equal(M.getPage(tree, b).props[n], 1000);
    D.retypeProperty(doc, tree, dbId, prop(doc, n), "checkbox", BY);
    assert.equal(M.getPage(tree, a).props[n], true);
    assert.equal(M.getPage(tree, e).props[n], false);

    const t = D.addProperty(doc, { type: "text", name: "T" });
    M.setProp(tree, a, t, "x, y", BY);
    D.retypeProperty(doc, tree, dbId, prop(doc, t), "multi_select", BY);
    assert.deepEqual(prop(doc, t).options.map((o) => o.name), ["x", "y"]);
    assert.equal(M.getPage(tree, a).props[t].length, 2);

    const idp = D.addProperty(doc, { type: "text", name: "I" });
    D.retypeProperty(doc, tree, dbId, prop(doc, idp), "id", BY);
    assert.deepEqual([b, c, a, e].map((r) => M.getPage(tree, r).props[idp]), [1, 2, 3, 4]);
    D.retypeProperty(doc, tree, dbId, prop(doc, D.TITLE), "number", BY);
    assert.equal(prop(doc, D.TITLE).type, "title");
  });
});

describe("collaboration", () => {
  function pair() {
    const a = new Y.Doc();
    D.initDatabase(a);
    const b = new Y.Doc();
    sync(a, b);
    return { a, b };
  }

  test("rename vs retype of the same property both land", () => {
    const { a, b } = pair();
    const p = D.addProperty(a, { type: "text", name: "P" });
    sync(a, b);
    D.renameProperty(a, p, "Renamed");
    D.updateProperty(b, p, { type: "number" });
    sync(a, b);
    assert.deepEqual(prop(a, p), prop(b, p));
    assert.equal(prop(a, p).name, "Renamed");
    assert.equal(prop(a, p).type, "number");
  });

  test("both add options", () => {
    const { a, b } = pair();
    D.addOption(a, D.DEFAULT_TAGS, "from-a");
    D.addOption(b, D.DEFAULT_TAGS, "from-b");
    sync(a, b);
    assert.deepEqual(prop(a, D.DEFAULT_TAGS).options.map((o) => o.name).sort(), ["from-a", "from-b"]);
    assert.deepEqual(prop(a, D.DEFAULT_TAGS).options, prop(b, D.DEFAULT_TAGS).options);
  });

  test("concurrent widths on different columns", () => {
    const { a, b } = pair();
    const p = D.addProperty(a, { type: "text", name: "P" });
    sync(a, b);
    D.setViewProp(a, D.DEFAULT_VIEW, p, { width: 300 });
    D.setViewProp(b, D.DEFAULT_VIEW, D.TITLE, { width: 410 });
    sync(a, b);
    for (const d of [a, b]) {
      const v = D.readViews(d)[0];
      assert.equal(v.props[p].width, 300);
      assert.equal(v.props[D.TITLE].width, 410);
    }
  });

  test("concurrent first-time setViewProp on the same column keeps both fields", () => {
    const { a, b } = pair();
    D.setViewProp(a, D.DEFAULT_VIEW, D.DEFAULT_TAGS, { width: 300 });
    D.setViewProp(b, D.DEFAULT_VIEW, D.DEFAULT_TAGS, { visible: false });
    sync(a, b);
    assert.deepEqual(D.readViews(a)[0].props[D.DEFAULT_TAGS], D.readViews(b)[0].props[D.DEFAULT_TAGS]);
    assert.deepEqual(D.readViews(a)[0].props[D.DEFAULT_TAGS], { width: 300, visible: false });
  });

  test("option delete vs rename converges", () => {
    const { a, b } = pair();
    const o = D.addOption(a, D.DEFAULT_TAGS, "x");
    sync(a, b);
    D.deleteOption(a, D.DEFAULT_TAGS, o);
    D.updateOption(b, D.DEFAULT_TAGS, o, { name: "y" });
    sync(a, b);
    assert.deepEqual(prop(a, D.DEFAULT_TAGS).options, prop(b, D.DEFAULT_TAGS).options);
    assert.equal(prop(a, D.DEFAULT_TAGS).options.length, 0);
  });

  test("view reorder vs rename keeps both", () => {
    const { a, b } = pair();
    const v2 = D.addView(a, "board");
    sync(a, b);
    D.moveView(a, v2, null);
    D.renameView(b, v2, "Kanban");
    sync(a, b);
    for (const d of [a, b]) {
      const views = D.readViews(d);
      assert.equal(views[0].id, v2);
      assert.equal(views[0].name, "Kanban");
      assert.equal(views.length, 2);
    }
  });

  test("concurrent property adds and deletes", () => {
    const { a, b } = pair();
    const p = D.addProperty(a, { type: "text", name: "P" });
    sync(a, b);
    D.deleteProperty(a, p);
    D.addProperty(b, { type: "number", name: "Q" });
    D.renameProperty(b, p, "P2");
    sync(a, b);
    assert.deepEqual(D.readSchema(a).map((x) => x.id), D.readSchema(b).map((x) => x.id));
    assert.equal(prop(a, p), undefined);
    assert.ok(byName(a, "Q"));
  });
});
