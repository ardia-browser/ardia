import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let T;
let D;
let M;
let Y;

before(async () => {
  const dir = join(tmpdir(), "ardia-notes-tests");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `templates-${process.pid}-${Date.now()}.mjs`);
  const src = fileURLToPath(new URL("../src/shared/", import.meta.url));
  await build({
    stdin: {
      contents: `export * as T from "./templates"; export * as D from "./database"; export * as M from "./model"; export * as Y from "yjs";`,
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
  ({ T, D, M, Y } = await import(pathToFileURL(outfile).href));
});

const BY = "device-test";
const NOW = new Date(2026, 10, 24, 10, 0).getTime();

function workspace() {
  const tree = new Y.Doc();
  const docs = new Map();
  const newDoc = (id) => {
    assert.ok(!docs.has(id), `doc ${id} created twice`);
    const doc = new Y.Doc();
    docs.set(id, doc);
    return doc;
  };
  return { tree, docs, target: { tree, by: BY, newDoc, now: NOW } };
}

const BLOCK_TYPES = new Set([
  "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "callout", "codeBlock", "equation",
  "divider", "toc", "subpage", "linkToPage", "database", "breadcrumb", "bookmark", "embed", "image", "video", "audio", "file", "table",
]);
const NO_CONTENT = new Set(["divider", "toc", "subpage", "linkToPage", "database", "breadcrumb", "bookmark", "embed", "image", "video", "audio", "file"]);
const ATTRS = {
  heading: ["level", "isToggleable", "textColor", "backgroundColor", "textAlignment"],
  checkListItem: ["checked", "textColor", "backgroundColor", "textAlignment"],
  callout: ["icon", "textColor", "backgroundColor"],
  codeBlock: ["language", "wrap", "view"],
  subpage: ["pageId"],
  linkToPage: ["pageId"],
  database: ["workspace", "database", "view"],
};
const MARKS = new Set(["bold", "italic", "underline", "strike", "code", "textColor", "backgroundColor", "link"]);
const PAGE_ID = /^[0-9a-f]{12}$/;

function checkInline(content, where, refs) {
  for (const node of content.toArray()) {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta()) {
        assert.equal(typeof op.insert, "string", `${where}: text runs only`);
        for (const mark of Object.keys(op.attributes ?? {})) assert.ok(MARKS.has(mark), `${where}: unknown mark ${mark}`);
        if (op.attributes?.link) assert.match(op.attributes.link.href, /^(https?:|mailto:|ardia:)/, `${where}: odd link`);
      }
    } else if (node instanceof Y.XmlElement) {
      assert.equal(node.nodeName, "mention", `${where}: unknown inline node ${node.nodeName}`);
      const kind = node.getAttribute("kind");
      if (kind === "page") refs.push({ id: node.getAttribute("pageId"), where });
      else {
        assert.equal(kind, "date", `${where}: mention kind`);
        assert.match(node.getAttribute("date"), /^\d{4}-\d{2}-\d{2}$/, `${where}: mention date`);
      }
    } else assert.fail(`${where}: odd inline`);
  }
}

function checkGroup(group, where, refs, stats, depth = 0) {
  assert.ok(group instanceof Y.XmlElement && group.nodeName === "blockGroup", `${where}: expected blockGroup`);
  assert.ok(group.length > 0, `${where}: empty group`);
  for (const node of group.toArray()) checkBlockNode(node, where, refs, stats, depth);
}

function checkBlockNode(node, where, refs, stats, depth) {
  assert.ok(node instanceof Y.XmlElement, `${where}: block is not an element`);
  if (node.nodeName === "columnList") {
    assert.ok(node.getAttribute("id"), `${where}: columnList id`);
    const cols = node.toArray();
    assert.ok(cols.length >= 2, `${where}: columns need two or more`);
    for (const col of cols) {
      assert.equal(col.nodeName, "column", `${where}: columnList holds columns`);
      assert.ok(col.length > 0, `${where}: empty column`);
      for (const child of col.toArray()) {
        assert.notEqual(child.nodeName, "columnList", `${where}: nested columns`);
        checkBlockNode(child, where, refs, stats, depth + 1);
      }
    }
    stats.columns++;
    return;
  }
  assert.equal(node.nodeName, "blockContainer", `${where}: expected blockContainer, got ${node.nodeName}`);
  assert.ok(node.getAttribute("id"), `${where}: block id`);
  const [content, children, extra] = node.toArray();
  assert.equal(extra, undefined, `${where}: too many children`);
  assert.ok(BLOCK_TYPES.has(content.nodeName), `${where}: unknown block ${content.nodeName}`);
  stats.blocks++;
  stats.types.add(content.nodeName);
  const attrs = content.getAttributes();
  const allowed = ATTRS[content.nodeName];
  if (allowed) for (const key of Object.keys(attrs)) assert.ok(allowed.includes(key), `${where}: ${content.nodeName} has odd attr ${key}`);
  for (const value of Object.values(attrs)) assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value), `${where}: unresolved attr ${JSON.stringify(value)}`);
  if (NO_CONTENT.has(content.nodeName)) assert.equal(content.length, 0, `${where}: ${content.nodeName} takes no text`);
  else checkInline(content, where, refs);
  if (content.nodeName === "heading") assert.ok([1, 2, 3].includes(attrs.level), `${where}: heading level`);
  if (["subpage", "linkToPage"].includes(content.nodeName)) refs.push({ id: attrs.pageId, where });
  if (content.nodeName === "database") refs.push({ id: attrs.database, view: attrs.view, where, database: true });
  if (content.nodeName === "codeBlock") assert.ok(attrs.language, `${where}: code language`);
  if (children !== undefined) checkGroup(children, where, refs, stats, depth + 1);
}

function contextFor(tree, docs, database) {
  const schemaFor = (id) => (docs.has(id) ? D.readSchema(docs.get(id)) : null);
  const people = new Map(D.readPeople(docs.get(database)).map((p) => [p.id, p]));
  return D.makeContext({
    database,
    schema: D.readSchema(docs.get(database)),
    rows: D.databaseRows(tree, database),
    page: (id) => M.getPage(tree, id),
    schemaFor,
    rowsFor: (id) => D.databaseRows(tree, id),
    people,
    now: NOW,
  });
}

function validate(template) {
  const { tree, docs, target } = workspace();
  const made = T.instantiateTemplate(target, template, { parent: "" });
  const rootMeta = M.getPage(tree, made.page);
  assert.ok(rootMeta, "root exists");
  assert.equal(rootMeta.parent, "");
  assert.equal(rootMeta.title, template.root.title);
  assert.equal(rootMeta.kind, template.root.kind);
  const nodes = T.allNodes(template);
  assert.equal(made.pages.length + made.databases.length, nodes.length, "one page per node");
  const stats = { blocks: 0, columns: 0, types: new Set(), rows: 0, views: new Set(), props: new Set() };
  for (const id of [...made.pages, ...made.databases]) {
    const meta = M.getPage(tree, id);
    assert.ok(meta && !meta.deleted, `page ${id} exists`);
    assert.ok(meta.title.trim(), `${template.id}: every page has a title`);
    const chain = M.ancestorsOf(tree, id).map((a) => a.id);
    assert.ok(id === made.page || chain.includes(made.page), `${meta.title} sits under the root`);
  }

  const refs = [];
  for (const id of [...made.pages, ...made.rows]) {
    const doc = docs.get(id);
    if (!doc) continue;
    const fragment = M.blocksOf(doc);
    assert.equal(fragment.length, 1, `${template.id}/${M.getPage(tree, id).title}: one root group`);
    checkGroup(fragment.get(0), `${template.id}/${M.getPage(tree, id).title}`, refs, stats);
  }
  for (const id of made.pages) assert.ok(docs.has(id), `${template.id}: page ${M.getPage(tree, id).title} has content`);
  for (const ref of refs) {
    assert.match(String(ref.id), PAGE_ID, `${ref.where}: page ref`);
    const meta = M.getPage(tree, ref.id);
    assert.ok(meta, `${ref.where}: ref ${ref.id} resolves`);
    if (ref.database) {
      assert.equal(meta.kind, "database", `${ref.where}: database block points at a database`);
      if (ref.view) assert.ok(D.readViews(docs.get(ref.id)).some((v) => v.id === ref.view), `${ref.where}: database block view exists`);
    }
  }

  for (const node of nodes.filter((n) => n.kind === "database")) {
    const id = made.refs.get(node.key) ?? made.databases[nodes.filter((n) => n.kind === "database").indexOf(node)];
    const doc = docs.get(id);
    const where = `${template.id}/${node.title}`;
    assert.ok(D.isInitialized(doc), `${where}: initialized`);
    const schema = D.readSchema(doc);
    assert.equal(schema[0].id, D.TITLE);
    assert.equal(schema[0].name, node.titleName ?? "Name", `${where}: title column name`);
    for (const spec of node.properties) {
      const prop = schema.find((p) => p.name === spec.name && p.type === spec.type);
      assert.ok(prop, `${where}: property ${spec.name} (${spec.type})`);
      stats.props.add(spec.type);
      if (spec.options) assert.deepEqual(prop.options.map((o) => o.name), spec.options.map((o) => (typeof o === "string" ? o : o.name)), `${where}: ${spec.name} options`);
      if (prop.type === "status") assert.ok(prop.options.every((o) => o.group), `${where}: ${spec.name} status groups`);
      if (prop.type === "relation") {
        const targetDoc = docs.get(prop.relation);
        assert.ok(targetDoc, `${where}: ${spec.name} target exists`);
        if (prop.twoWay) {
          const back = D.readSchema(targetDoc).find((p) => p.id === prop.backProp);
          assert.ok(back && back.type === "relation" && back.relation === id && back.backProp === prop.id, `${where}: ${spec.name} two-way back property`);
        }
      }
      if (prop.type === "rollup") {
        const relation = schema.find((p) => p.id === prop.rollupRelation && p.type === "relation");
        assert.ok(relation, `${where}: ${spec.name} rollup relation`);
        const targetSchema = D.readSchema(docs.get(relation.relation));
        assert.ok(targetSchema.some((p) => p.id === prop.rollupTarget), `${where}: ${spec.name} rollup target`);
      }
      if (prop.type === "formula") assert.ok(!("error" in D.compileFormula(prop.expression) && !("k" in D.compileFormula(prop.expression))), `${where}: ${spec.name} formula parses`);
    }
    const views = D.readViews(doc);
    assert.equal(views.length, node.views.length, `${where}: view count`);
    const ctx = contextFor(tree, docs, id);
    const rows = D.databaseRows(tree, id);
    assert.equal(rows.length, node.rows.length, `${where}: row count`);
    assert.equal(D.databaseRows(tree, id, { templates: true }).length, (node.rowTemplates ?? []).length, `${where}: row templates`);
    assert.ok(rows.length >= 3, `${where}: at least three sample rows`);
    stats.rows += rows.length;
    const ids = new Set(schema.map((p) => p.id));
    views.forEach((view, index) => {
      const spec = node.views[index];
      assert.equal(view.type, spec.type, `${where}: view ${spec.name} type`);
      assert.equal(view.name, spec.name);
      stats.views.add(view.type);
      for (const s of view.sorts) assert.ok(ids.has(s.prop), `${where}: ${view.name} sort prop`);
      if (view.groupBy) assert.ok(ids.has(view.groupBy.prop), `${where}: ${view.name} group prop`);
      if (view.type === "board") assert.ok(view.groupBy, `${where}: board ${view.name} groups`);
      if (view.type === "calendar" || view.type === "timeline") {
        assert.ok(ids.has(view.dateProp), `${where}: ${view.name} date prop`);
        const dateType = schema.find((p) => p.id === view.dateProp).type;
        assert.ok(["date", "created_time", "edited_time", "formula"].includes(dateType), `${where}: ${view.name} date prop type`);
      }
      if (view.type === "chart") assert.ok(ids.has(view.chartBy), `${where}: ${view.name} chart prop`);
      const walk = (group) => group.rules.forEach((r) => (r.kind === "group" ? walk(r) : assert.ok(ids.has(r.prop), `${where}: ${view.name} filter prop`)));
      walk(view.filter);
      for (const key of Object.keys(view.props)) assert.ok(ids.has(key), `${where}: ${view.name} shows a missing prop`);
      const result = D.computeView(ctx, view);
      assert.ok(result.total > 0, `${where}: view ${view.name} shows rows`);
    });
    for (const row of [...rows, ...D.databaseRows(tree, id, { templates: true })]) {
      for (const prop of schema) {
        const value = D.fvalue(ctx, row, prop);
        assert.ok(!D.isError(value), `${where}/${row.title}: ${prop.name} = ${JSON.stringify(value)}`);
        if (prop.type === "select" || prop.type === "status") {
          const raw = row.props[prop.id];
          if (raw !== undefined) assert.ok(prop.options.some((o) => o.id === raw), `${where}/${row.title}: ${prop.name} option`);
        }
        if (prop.type === "relation") for (const target of D.idsValue(row, prop)) assert.ok(M.getPage(tree, target)?.parent === prop.relation, `${where}/${row.title}: ${prop.name} points into its database`);
        if (prop.type === "person") for (const person of D.idsValue(row, prop)) assert.ok(person === BY || ctx.people.has(person), `${where}/${row.title}: ${prop.name} person known`);
      }
    }
    if (node.inline) {
      const parentId = M.getPage(tree, id).parent;
      const parentDoc = docs.get(parentId);
      assert.ok(parentDoc && M.blocksOf(parentDoc).toString().includes(`database="${id}"`), `${where}: inline database is placed in its page`);
    }
  }
  return { made, stats, tree, docs };
}

describe("template catalog", () => {
  test("has 40+ templates with unique ids, every category filled", () => {
    assert.ok(T.TEMPLATES.length >= 40, `only ${T.TEMPLATES.length} templates`);
    assert.equal(new Set(T.TEMPLATE_IDS).size, T.TEMPLATE_IDS.length);
    for (const c of T.TEMPLATE_CATEGORIES) assert.ok(T.TEMPLATES.filter((t) => t.category === c.id).length >= 3, `${c.name} has templates`);
    for (const t of T.TEMPLATES) {
      assert.match(t.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${t.id} id`);
      assert.ok(t.description.length >= 40 && t.description.length <= 220, `${t.id} description length ${t.description.length}`);
      assert.ok(t.root.icon, `${t.id} icon`);
      assert.ok(T.TEMPLATE_CATEGORIES.some((c) => c.id === t.category), `${t.id} category`);
      if (t.root.cover) assert.match(t.root.cover, /^(gradient:([0-9]|1[01])|color:[0-9])$/, `${t.id} cover is built in`);
      assert.doesNotMatch(JSON.stringify(t), /notion/i, `${t.id} names no other product`);
      assert.doesNotMatch(JSON.stringify(t), /https?:\/\/[^"]*\.(png|jpe?g|gif|webp|svg)/i, `${t.id} uses no external images`);
    }
  });

  test("every template instantiates through the real model and validates", () => {
    const failures = [];
    const totals = { blocks: 0, rows: 0, views: new Set(), props: new Set() };
    for (const template of T.TEMPLATES) {
      try {
        const { stats } = validate(template);
        assert.ok(stats.blocks >= 4, `${template.id}: only ${stats.blocks} blocks`);
        totals.blocks += stats.blocks;
        totals.rows += stats.rows;
        stats.views.forEach((v) => totals.views.add(v));
        stats.props.forEach((p) => totals.props.add(p));
      } catch (error) {
        failures.push(`${template.id}: ${error.message.split("\n")[0]}`);
      }
    }
    assert.deepEqual(failures, []);
    for (const view of ["table", "board", "calendar", "timeline", "gallery", "list", "chart"]) assert.ok(totals.views.has(view), `some template uses a ${view} view`);
    for (const type of ["status", "select", "multi_select", "date", "person", "relation", "rollup", "formula", "checkbox", "number", "url"]) assert.ok(totals.props.has(type), `some template uses ${type}`);
  });

  test("two uses never share ids, and a use can go inside a page", () => {
    const { tree, docs, target } = workspace();
    const template = T.templateById("project-tracker");
    const parent = M.createPage(tree, { parent: "", kind: "page", title: "Work", by: BY });
    target.newDoc(parent);
    const a = T.instantiateTemplate(target, template, { parent });
    const b = T.instantiateTemplate(target, template, { parent });
    assert.notEqual(a.page, b.page);
    const overlap = [...a.pages, ...a.databases, ...a.rows].filter((id) => [...b.pages, ...b.databases, ...b.rows].includes(id));
    assert.deepEqual(overlap, []);
    assert.deepEqual(M.childrenOf(tree, parent).map((p) => p.id), [a.page, b.page]);
    assert.ok(docs.get(a.page));
  });

  test("into fills an empty page and keeps its own title", () => {
    const { tree, target } = workspace();
    const host = M.createPage(tree, { parent: "", kind: "page", title: "My plan", by: BY });
    const doc = target.newDoc(host);
    const made = T.instantiateTemplate(target, T.TEMPLATES.find((t) => t.root.kind === "page"), { into: { page: host, doc } });
    assert.equal(made.page, host);
    assert.equal(M.getPage(tree, host).title, "My plan");
    assert.ok(M.blocksOf(doc).length > 0);
    const dbRoot = T.TEMPLATES.find((t) => t.root.kind === "database");
    if (dbRoot) {
      const other = M.createPage(tree, { parent: "", kind: "page", title: "", by: BY });
      const otherDoc = target.newDoc(other);
      const made2 = T.instantiateTemplate(target, dbRoot, { into: { page: other, doc: otherDoc } });
      assert.equal(made2.page, other);
      assert.equal(M.getPage(tree, other).title, dbRoot.root.title);
      assert.match(M.blocksOf(otherDoc).toString(), new RegExp(`database="${made2.databases[0]}"`));
      assert.equal(M.getPage(tree, made2.databases[0]).parent, other);
    }
  });

  test("lock makes a read-only preview", () => {
    const { tree, docs, target } = workspace();
    const made = T.instantiateTemplate(target, T.templateById("project-tracker"), { lock: true });
    for (const id of [...made.pages, ...made.databases, ...made.rows]) assert.equal(M.getPage(tree, id).locked, true);
    for (const id of made.databases) assert.equal(D.readSettings(docs.get(id)).locked, true);
  });

  test("search finds by title, tag and category, and ranks titles first", () => {
    assert.equal(T.searchTemplates("project")[0].id, "project-tracker");
    assert.ok(T.searchTemplates("kanban").some((t) => t.id === "project-tracker"));
    assert.deepEqual(T.searchTemplates("zzzz-nothing"), []);
    assert.equal(T.searchTemplates("", "work").length, T.TEMPLATES.filter((t) => t.category === "work").length);
    assert.ok(T.searchTemplates("tracker", "school").every((t) => t.category === "school"));
  });

  test("dates are relative to the day it's used", () => {
    assert.deepEqual(T.dateCell({ d: 0 }, NOW), { start: "2026-11-24" });
    assert.deepEqual(T.dateCell({ d: 2, end: 5 }, NOW), { start: "2026-11-26", end: "2026-11-29" });
    assert.deepEqual(T.dateCell({ d: -1, at: "09:30" }, NOW), { start: "2026-11-23T09:30" });
  });

  test("a broken spec fails loudly", () => {
    const { target } = workspace();
    const bad = { id: "bad", title: "Bad", description: "x".repeat(50), category: "work", root: { kind: "database", title: "Bad", properties: [{ key: "s", name: "S", type: "select", options: ["A"] }], views: [{ name: "T", type: "table" }], rows: [{ title: "r", values: { s: "B" } }] } };
    assert.throws(() => T.instantiateTemplate(target, bad), /no option "B"/);
  });
});
