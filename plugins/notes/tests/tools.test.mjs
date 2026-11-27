import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { until } from "./support/build.mjs";

const outfile = join(tmpdir(), "ardia-notes-tests", `tools-${process.pid}-${Date.now()}.mjs`);
mkdirSync(join(tmpdir(), "ardia-notes-tests"), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./support/tools-entry.ts", import.meta.url))],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  alias: { "@ardia/plugin-sdk": fileURLToPath(new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url)) },
});
const M = await import(pathToFileURL(outfile).href);
const { Y, model } = M;

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function device(dir = mkdtempSync(join(tmpdir(), "notes-tools-")), storage = new Map()) {
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, join(dir, "shared"), []);
  const hub = M.pageHub();
  const opened = [];
  const host = {
    files,
    folders,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: (k) => ({ name: "Ada", searchEverywhere: true })[k],
    post: hub.post,
    openPage: async (p) => void opened.push(p),
    openUrl: async () => undefined,
    store: { debounceMs: 5, rescanMs: 200 },
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  await notes.start();
  await until(() => notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  await notes.whenIdle();
  const handlers = M.makeHandlers(() => notes.access());
  const call = async (tool, input) => {
    const out = await handlers[tool](input);
    JSON.stringify(out);
    return out;
  };
  const fails = async (tool, input, pattern) => {
    await assert.rejects(() => handlers[tool](input), (e) => {
      assert.match(e.message, pattern);
      return true;
    });
  };
  const pages = [];
  const d = {
    dir,
    storage,
    notes,
    hub,
    opened,
    call,
    fails,
    ws: notes.workspaces()[0].id,
    open(view) {
      const p = hub.open(view);
      pages.push(p);
      return p;
    },
    async stop() {
      for (const p of pages) p.close();
      await notes.stop();
      files.detach();
    },
  };
  cleanups.push(() => d.stop());
  return d;
}

const RICH = `Plain text with **bold**, *italic*, ~~strike~~, <u>under</u>, \`code\` and a [link](https://example.com).
A second line in the same paragraph.

# Heading one

## Heading two {textColor=red}

### Heading three

- bullet one
  - nested bullet
- bullet two

1. first
2. second

- [ ] open task
- [x] done task

> A quote

> [!🔥] A callout with an icon

<details><summary>A toggle</summary>

Inside the toggle

</details>

<details><summary>## Toggle heading</summary>

Under the toggle heading

</details>

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`

$$
e^{i\\pi} + 1 = 0
$$

---

| Name | Qty |
| --- | --- |
| Apples | 3 |
| Pears | 5 |

![A cat](https://example.com/cat.png)

::bookmark(https://ardia.dev)

::toc

Math $x^2$, a date @date(2026-11-24), and <span color="blue">blue text</span>.
`;

test("describe returns the whole surface as data, under 1 MB", async () => {
  const d = await device();
  const all = await d.call("describe", {});
  assert.deepEqual(Object.keys(all.tools).sort(), [...M.TOOL_NAMES].sort());
  assert.ok(M.TOOL_NAMES.length <= 32);
  assert.ok(all.blocks.types.heading.props.level);
  assert.ok(all.database.formula.functions.includes("prop"));
  assert.ok(all.patchOps.update);
  assert.ok(JSON.stringify(all).length < 1_000_000);
  const one = await d.call("describe", { topic: "rows" });
  assert.ok(one.actions.query.input.properties.filter);
  await d.fails("describe", { topic: "rowz" }, /did you mean 'rows'/);
});

test("validation names the field, refuses unknown fields and suggests near misses", async () => {
  const d = await device();
  await d.fails("pages", { action: "craete" }, /'craete' isn't an action of pages; did you mean 'create'\?/);
  await d.fails("pages", {}, /pages needs an action/);
  await d.fails("pages", { action: "create", titel: "x" }, /unknown field 'titel' in pages create; did you mean 'title'\?/);
  await d.fails("pages", { action: "update", page: "nope-not-here", title: "x" }, /no page called/);
  await d.fails("pages", { action: "create", font: "comic" }, /isn't one of 'default', 'serif', 'mono'/);
  await d.fails("content", { action: "set", page: "Getting Started", blocks: [{ type: "paragrph" }] }, /did you mean 'paragraph'/);
  await d.fails("content", { action: "set", page: "Getting Started", blocks: [{ type: "heading", props: { lvl: 2 } }] }, /unknown prop 'lvl' for a heading/);
  await d.fails("content", { action: "set", page: "Getting Started", markdown: "hello {color=red}" }, /unknown prop 'color' for a paragraph.*'textColor'/);
  await d.fails("pages", { action: "update", page: "Getting Started", icon: "notanemoji" }, /one emoji/);
});

test("markdown round-trips through Yjs, and blocks round-trip exactly", async () => {
  const d = await device();
  const { page } = await d.call("pages", { action: "create", title: "Rich", markdown: RICH });
  const md = await d.call("content", { action: "get", page: page.id, title: false });
  assert.equal(md.markdown.trim(), RICH.trim());
  const blocks = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks;
  const types = blocks.map((b) => b.type);
  for (const t of ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "callout", "toggleListItem", "codeBlock", "equation", "divider", "table", "image", "bookmark", "toc"]) assert.ok(types.includes(t), t);
  assert.equal(blocks.find((b) => b.type === "bulletListItem").children[0].type, "bulletListItem");
  const toggleHeading = blocks.find((b) => b.type === "heading" && b.props.isToggleable);
  assert.equal(toggleHeading.children[0].content[0].text, "Under the toggle heading");
  const first = blocks[0].content;
  assert.deepEqual(first[1], { type: "text", text: "bold", styles: { bold: true } });
  assert.equal(first.find((i) => i.type === "link").href, "https://example.com");
  const second = await d.call("pages", { action: "create", title: "Copy", blocks });
  const back = (await d.call("content", { action: "get", page: second.page.id, format: "blocks" })).blocks;
  assert.deepEqual(back, blocks);
  const doc = new Y.Doc();
  M.writeDoc(doc.getXmlFragment("blocks"), blocks);
  assert.deepEqual(M.readDoc(doc.getXmlFragment("blocks")), blocks);
});

test("content writes reach an open page live, and set merge keeps unchanged blocks and their ids", async () => {
  const d = await device();
  const { page } = await d.call("pages", { action: "create", title: "Live", markdown: "One\n\nTwo\n\nThree" });
  const view = d.open("v1");
  await view.client.ready;
  const handle = view.client.open(d.ws, `p:${page.id}`);
  await handle.synced;
  const before = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks;
  await d.call("content", { action: "set", page: page.id, markdown: "One\n\nTwo, edited\n\nThree\n\nFour" });
  await until(() => M.readDoc(handle.doc.getXmlFragment("blocks")).length === 4, 5000, "the page sees the write");
  const live = M.readDoc(handle.doc.getXmlFragment("blocks"));
  assert.equal(live[0].id, before[0].id);
  assert.equal(live[1].id, before[1].id);
  assert.equal(live[2].id, before[2].id);
  assert.equal(live[1].content[0].text, "Two, edited");
  const r = await d.call("content", { action: "set", page: page.id, markdown: (await d.call("content", { action: "get", page: page.id, ids: true, title: false })).markdown.replace("Three", "Three!") });
  assert.equal(r.stats.updated, 1);
  assert.equal(r.stats.kept, 3);
  handle.release();
});

test("patch ops edit surgically and keep a collaborator's concurrent edits", async () => {
  const d = await device();
  const { page } = await d.call("pages", { action: "create", title: "Team", markdown: "Alpha line\n\nBeta line\n\nGamma line" });
  const view = d.open("v2");
  await view.client.ready;
  const handle = view.client.open(d.ws, `p:${page.id}`);
  await handle.synced;
  const ids = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks.map((b) => b.id);
  const textOf = (id) => {
    const walk = (node) => {
      for (const c of node.toArray()) {
        if (c instanceof Y.XmlElement) {
          if (c.nodeName === "blockContainer" && c.getAttribute("id") === id) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
      }
      return null;
    };
    const container = walk(handle.doc.getXmlFragment("blocks"));
    return container.toArray()[0].toArray()[0];
  };
  const pending = d.call("content", {
    action: "patch",
    page: page.id,
    ops: [
      { op: "update", id: ids[0], markdown: "Alpha line, **rewritten**" },
      { op: "insert", after: ids[1], markdown: "- inserted bullet" },
      { op: "update", id: ids[1], props: { textColor: "blue" } },
      { op: "replace_text", find: "Gamma", replace: "Delta" },
    ],
  });
  textOf(ids[1]).insert(0, "Bob: ");
  textOf(ids[2]).insert("Gamma line".length, " (Bob)");
  await pending;
  const serverBlocks = async () => (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks;
  let server = null;
  await until(async () => {
    server = await serverBlocks();
    return JSON.stringify(server) === JSON.stringify(M.readDoc(handle.doc.getXmlFragment("blocks"))) && server.length === 4 && JSON.stringify(server).includes("(Bob)");
  }, 5000, "the page and main converge");
  const text = (b) => b.content.map((c) => c.text).join("");
  assert.equal(text(server[0]), "Alpha line, rewritten");
  assert.deepEqual(server[0].content[1], { type: "text", text: "rewritten", styles: { bold: true } });
  assert.equal(text(server[1]), "Bob: Beta line");
  assert.equal(server[1].props.textColor, "blue");
  assert.equal(server[2].type, "bulletListItem");
  assert.equal(text(server[3]), "Delta line (Bob)");
  await d.call("content", { action: "patch", page: page.id, ops: [{ op: "update", id: ids[2], markdown: "Delta line (Bob) and more" }] });
  textOf(ids[2]).insert(0, ">> ");
  await until(() => text(M.readDoc(handle.doc.getXmlFragment("blocks"))[3]) === ">> Delta line (Bob) and more", 5000, "both edits merge in one block");
  await d.fails("content", { action: "patch", page: page.id, ops: [{ op: "delete", id: ids[0] }, { op: "delete", id: "missing" }] }, /ops\[1\] \(delete\)\.id: there's no block 'missing'/);
  assert.equal((await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks.length, 4, "a failed patch changes nothing");
  await d.call("content", { action: "patch", page: page.id, ops: [{ op: "move", id: ids[0], after: ids[2] }, { op: "delete", id: ids[1] }] });
  const moved = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks.map((b) => b.id);
  assert.equal(moved.at(-1), ids[0]);
  assert.ok(!moved.includes(ids[1]));
  handle.release();
});

test("pages: create, nest, update, move, duplicate, trash, restore, delete, open, backlinks, search", async () => {
  const d = await device();
  const parent = (await d.call("pages", { action: "create", markdown: "# 🚀 Launch\n\nThe plan." })).page;
  assert.equal(parent.title, "Launch");
  assert.equal(parent.icon, "🚀");
  const child = (await d.call("pages", { action: "create", parent: parent.id, title: "Checklist", markdown: `Back to @page(${parent.id})` })).page;
  assert.equal(child.parent, parent.id);
  const parentBlocks = (await d.call("content", { action: "get", page: parent.id, format: "blocks" })).blocks;
  assert.equal(parentBlocks.at(-1).type, "subpage");
  const updated = (await d.call("pages", { action: "update", page: "Checklist", font: "serif", fullWidth: true, cover: "gradient:3" })).page;
  assert.equal(updated.font, "serif");
  assert.equal(updated.cover, "gradient:3");
  const links = await d.call("pages", { action: "backlinks", page: parent.id });
  assert.deepEqual(links.backlinks.map((b) => b.page), [child.id]);
  const found = await d.call("search", { query: "plan" });
  assert.ok(found.hits.some((h) => h.id === parent.id));
  await d.call("pages", { action: "move", page: child.id, parent: "" });
  assert.equal((await d.call("pages", { action: "get", page: child.id, content: "none" })).page.parent, "");
  const copy = (await d.call("pages", { action: "duplicate", page: parent.id })).page;
  assert.equal(copy.title, "Launch (1)");
  await d.call("pages", { action: "archive", page: copy.id });
  assert.ok((await d.call("trash", { action: "list" })).trash.some((t) => t.id === copy.id));
  await d.fails("content", { action: "append", page: copy.id, markdown: "x" }, /in the trash/);
  await d.call("trash", { action: "restore", page: copy.id });
  await d.fails("pages", { action: "delete", page: copy.id }, /isn't in the trash/);
  await d.call("pages", { action: "archive", page: copy.id });
  await d.call("trash", { action: "delete", page: copy.id });
  await d.fails("pages", { action: "get", page: copy.id }, /no page/);
  await d.call("pages", { action: "open", page: parent.id });
  assert.equal(d.opened.at(-1), `/Launch-${parent.id}`);
  const tree = await d.call("pages", { action: "tree" });
  assert.ok(tree.pages.some((p) => p.id === parent.id));
  await d.call("pages", { action: "update", page: parent.id, locked: true });
  await d.fails("content", { action: "append", page: parent.id, markdown: "x" }, /is locked/);
  await d.call("content", { action: "append", page: parent.id, markdown: "forced", force: true });
});

test("databases: schema, options, views, rows with filters and sorts, formulas, relations, rollups", async () => {
  const d = await device();
  const people = await d.call("database", {
    action: "create",
    title: "Projects",
    properties: [
      { name: "Status", type: "status" },
      { name: "Budget", type: "number", format: "dollar" },
      { name: "Due", type: "date" },
      { name: "Tags", type: "multi_select", options: [{ name: "web", color: "blue" }, "ios"] },
    ],
  });
  assert.deepEqual(people.properties.map((p) => p.name), ["Name", "Status", "Budget", "Due", "Tags"]);
  const db = people.database.id;
  await d.fails("rows", { action: "create", database: db, rows: [{ title: "x", properties: { Statu: "Done" } }] }, /unknown property 'Statu'; did you mean 'Status'\?/);
  await d.fails("rows", { action: "create", database: db, rows: [{ title: "x", properties: { Status: "Shipped" } }] }, /'Status' has no option 'Shipped'.*'Not started', 'In progress', 'Done'/);
  await d.fails("rows", { action: "create", database: db, rows: [{ title: "x", properties: { Budget: "lots" } }] }, /'Budget' takes a number/);
  const created = await d.call("rows", {
    action: "create",
    database: db,
    rows: [
      { title: "Site", properties: { Status: "In progress", Budget: 1200, Due: "2026-12-01", Tags: ["web", "new tag"] }, markdown: "Body of the site row" },
      { title: "App", properties: { Status: "Not started", Budget: 5000, Tags: "ios" } },
      { title: "Docs", properties: { Status: "Done", Budget: 300 } },
    ],
  });
  assert.equal(created.created.length, 3);
  assert.deepEqual(created.created[0].properties.Tags, ["web", "new tag"]);
  const schema = await d.call("properties", { action: "list", database: db });
  assert.ok(schema.properties.find((p) => p.name === "Tags").options.some((o) => o.name === "new tag"));
  await d.call("properties", { action: "add", database: "Projects", name: "Cost x2", type: "formula", expression: 'prop("Budget") * 2' });
  await d.fails("properties", { action: "add", database: db, name: "Bad", type: "formula", expression: 'prop("Budget" *' }, /doesn't parse/);
  const q = await d.call("rows", { action: "query", database: db, filter: { op: "and", rules: [{ prop: "Budget", cond: "gt", value: 500 }] }, sorts: [{ prop: "Budget", dir: "desc" }] });
  assert.deepEqual(q.rows.map((r) => r.title), ["App", "Site"]);
  assert.equal(q.rows[0].properties["Cost x2"], 10000);
  const nested = await d.call("rows", { action: "query", database: db, filter: { op: "or", rules: [{ prop: "Status", cond: "is", value: "Done" }, { op: "and", rules: [{ prop: "Tags", cond: "contains", value: "web" }] }] } });
  assert.deepEqual(nested.rows.map((r) => r.title).sort(), ["Docs", "Site"]);
  const paged = await d.call("rows", { action: "query", database: db, limit: 2 });
  assert.equal(paged.rows.length, 2);
  assert.equal(paged.nextCursor, "2");
  const board = await d.call("views", { action: "add", database: db, type: "board", name: "By status", groupBy: { prop: "Status" }, properties: { Budget: { visible: true } }, cardSize: "large" });
  assert.equal(board.view.groupBy.prop, "Status");
  assert.equal(board.view.properties.Budget.visible, true);
  const tableView = (await d.call("views", { action: "list", database: db })).views[0];
  const changed = await d.call("views", { action: "update", database: db, view: tableView.id, filter: [{ prop: "Status", cond: "is_not", value: ["Done"] }], sorts: ["Name"], properties: { Due: { width: 240, visible: false } }, wrap: true, frozen: 2, calculations: { Budget: "sum" }, order: ["Name", "Budget", "Status"] });
  assert.equal(changed.view.properties.Due.width, 240);
  assert.equal(changed.view.properties.Due.visible, false);
  assert.equal(changed.view.calculations.Budget, "sum");
  assert.deepEqual(changed.view.order.slice(0, 3), ["Name", "Budget", "Status"]);
  assert.deepEqual(changed.view.filter.rules[0], { prop: "Status", cond: "is_not", value: ["Done"] });
  const viaView = await d.call("rows", { action: "query", database: db, view: tableView.id });
  assert.deepEqual(viaView.rows.map((r) => r.title), ["App", "Site"]);
  await d.fails("views", { action: "update", database: db, view: tableView.id, filter: [{ prop: "Budget", cond: "contains", value: 1 }] }, /cond for 'Budget' \(number\) must be one of/);
  const tasks = await d.call("database", { action: "create", title: "Work items", properties: [{ name: "Hours", type: "number" }] });
  await d.call("properties", { action: "add", database: "Work items", name: "Project", type: "relation", relation: "Projects", twoWay: true, relatedName: "Tasks" });
  await d.call("rows", { action: "create", database: "Work items", rows: [{ title: "Design", properties: { Hours: 3, Project: ["Site"] } }, { title: "Build", properties: { Hours: 5, Project: ["Site"] } }] });
  await d.call("properties", { action: "add", database: "Projects", name: "Total hours", type: "rollup", rollupRelation: "Tasks", rollupTarget: "Hours", rollupFn: "sum" });
  const site = (await d.call("rows", { action: "query", database: db, search: "Site" })).rows[0];
  assert.equal(site.properties["Total hours"], 8);
  assert.deepEqual(site.properties.Tasks.map((t) => t.title).sort(), ["Build", "Design"]);
  await d.call("properties", { action: "update", database: db, property: "Budget", name: "Cost" });
  await d.call("properties", { action: "update", database: db, property: "Tags", options: [{ name: "ios", color: "red" }, { name: "web" }] });
  const tags = (await d.call("properties", { action: "list", database: db })).properties.find((p) => p.name === "Tags");
  assert.deepEqual(tags.options.map((o) => [o.name, o.color]), [["ios", "red"], ["web", "default"]]);
  await d.call("properties", { action: "update", database: db, property: "Due", type: "text" });
  const row = await d.call("rows", { action: "get", row: site.id });
  assert.equal(typeof row.row.properties.Due, "string");
  assert.equal(row.row.markdown.trim(), "Body of the site row");
  await d.call("rows", { action: "update", rows: [{ id: site.id, properties: { Status: "Done", Cost: null } }] });
  assert.equal((await d.call("rows", { action: "get", row: site.id })).row.properties.Cost, null);
  await d.call("rows", { action: "delete", rows: [site.id] });
  assert.equal((await d.call("rows", { action: "query", database: db })).total, 2);
  await d.call("rows", { action: "restore", rows: [site.id] });
  await d.fails("properties", { action: "delete", database: db, property: "Name" }, /can't be deleted/);
  const inline = await d.call("database", { action: "create", parent: (await d.call("pages", { action: "create", title: "Host page" })).page.id, inline: true, title: "Inline db", view: "board" });
  assert.equal(inline.views[0].type, "board");
  const host = (await d.call("content", { action: "get", page: "Host page", format: "blocks" })).blocks;
  assert.equal(host.at(-1).type, "database");
  assert.equal(host.at(-1).props.database, inline.database.id);
});

test("comments, history, templates, files, export, and durability across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-tools-"));
  const storage = new Map();
  const d = await device(dir, storage);
  const { page } = await d.call("pages", { action: "create", title: "Review", markdown: "Please check this sentence." });
  const blockId = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks[0].id;
  const t = await d.call("comments", { action: "add", page: page.id, block: blockId, quote: "this sentence", text: "Is this right?" });
  assert.equal(t.thread.quote, "this sentence");
  assert.equal(t.thread.block, blockId);
  await d.call("comments", { action: "reply", page: page.id, thread: t.thread.id, text: "Yes." });
  await d.call("comments", { action: "add", page: page.id, text: "Page-level note" });
  let list = await d.call("comments", { action: "list", page: page.id });
  assert.equal(list.threads.length, 2);
  await d.call("comments", { action: "resolve", page: page.id, thread: t.thread.id });
  list = await d.call("comments", { action: "list", page: page.id });
  assert.equal(list.threads.length, 1);
  assert.equal((await d.call("comments", { action: "list", page: page.id, resolved: "all" })).threads.length, 2);
  const after = await d.call("content", { action: "get", page: page.id, format: "blocks" });
  assert.equal(after.blocks[0].content.map((c) => c.text).join(""), "Please check this sentence.");
  const tpl = (await d.call("templates", { action: "create", title: "Meeting", markdown: "## Agenda\n\n- [ ] item" })).page;
  assert.equal(tpl.isTemplate, true);
  assert.ok((await d.call("templates", { action: "list" })).templates.some((x) => x.id === tpl.id));
  const used = (await d.call("templates", { action: "apply", template: tpl.id, title: "Monday" })).page;
  assert.equal(used.isTemplate, false);
  assert.match((await d.call("content", { action: "get", page: used.id })).markdown, /## Agenda\n\n- \[ \] item/);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const up = await d.call("files", { action: "upload", name: "dot.png", type: "image/png", data: png });
  assert.match(up.ref, /^file:[0-9a-f]{64}$/);
  const got = await d.call("files", { action: "get", ref: up.ref });
  assert.equal(got.data, png);
  await d.call("content", { action: "append", page: page.id, blocks: [{ type: "image", props: { url: up.ref, caption: "dot" } }] });
  assert.equal((await d.call("files", { action: "list", page: page.id })).files[0].ref, up.ref);
  const html = await d.call("export", { page: page.id, format: "html" });
  assert.match(html.files[0].text, /<img src="file:/);
  const md = await d.call("export", { page: tpl.id, subtree: true });
  assert.match(md.files[0].text, /^# Meeting/);
  const hist = await d.call("history", { action: "list", page: page.id });
  assert.ok(Array.isArray(hist.versions));
  await d.call("me", { action: "set", name: "Ada Lovelace" });
  assert.equal((await d.call("me", { action: "get" })).me.name, "Ada Lovelace");
  await d.notes.whenIdle();
  await d.stop();
  cleanups.pop();
  const again = await device(dir, storage);
  const reread = await again.call("content", { action: "get", page: page.id });
  assert.match(reread.markdown, /Please check this sentence\./);
  assert.equal((await again.call("comments", { action: "list", page: page.id, resolved: "all" })).threads.length, 2);
  const counts = storage.get("toolCounts");
  assert.ok(counts.calls["content.get"] >= 1);
});

test("hostile inputs through every tool field stay inert at the Yjs sink", async () => {
  const { HOSTILE_VALUES, URL_SCHEMES } = await import("../../../scripts/security/hostile-inputs.mjs");
  const d = await device();
  const { page } = await d.call("pages", { action: "create", title: "Sink" });
  const db = (await d.call("database", { action: "create", title: "Sinkdb", properties: [{ name: "Link", type: "url" }, { name: "Kind", type: "select" }] })).database.id;
  const row = (await d.call("rows", { action: "create", database: db, rows: [{ title: "r" }] })).created[0].id;
  const attempts = [];
  for (const { id, value } of HOSTILE_VALUES) {
    attempts.push(
      [`content.markdown ${id}`, () => d.call("content", { action: "append", page: page.id, markdown: `[x](${typeof value === "string" ? value : ""}) ${typeof value === "string" ? value : ""}` })],
      [`content.link ${id}`, () => d.call("content", { action: "append", page: page.id, blocks: [{ type: "paragraph", content: [{ type: "link", href: value, content: "x" }] }] })],
      [`content.image ${id}`, () => d.call("content", { action: "append", page: page.id, blocks: [{ type: "image", props: { url: value } }] })],
      [`pages.title ${id}`, () => d.call("pages", { action: "update", page: page.id, title: value })],
      [`pages.ref ${id}`, () => d.call("pages", { action: "get", page: value })],
      [`rows.url ${id}`, () => d.call("rows", { action: "update", rows: [{ id: row, properties: { Link: value } }] })],
      [`rows.prop ${id}`, () => d.call("rows", { action: "update", rows: [{ id: row, properties: { [typeof value === "string" ? value : "x"]: 1 } }] })],
      [`rows.select ${id}`, () => d.call("rows", { action: "update", rows: [{ id: row, properties: { Kind: value } }] })],
      [`content.patch ${id}`, () => d.call("content", { action: "patch", page: page.id, ops: [{ op: value }] })],
    );
  }
  let refused = 0;
  for (const [name, run] of attempts) {
    try {
      await run();
    } catch (e) {
      assert.ok(e instanceof Error && typeof e.message === "string", name);
      refused++;
    }
  }
  assert.ok(refused > 0, "the positive control: some hostile inputs were refused");
  const blocks = (await d.call("content", { action: "get", page: page.id, format: "blocks" })).blocks;
  const hrefs = [];
  const urls = [];
  const walk = (list) => {
    for (const b of list) {
      if (typeof b.props.url === "string") urls.push(b.props.url);
      if (Array.isArray(b.content)) for (const i of b.content) if (i.type === "link") hrefs.push(i.href);
      walk(b.children);
    }
  };
  walk(blocks);
  for (const h of hrefs) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h.replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/g, ""))?.[1]?.toLowerCase();
    assert.ok(!scheme || ["http", "https", "mailto", "tel"].includes(scheme) || h.startsWith("ardia://notes/"), `link ${JSON.stringify(h)}`);
  }
  for (const u of urls) assert.match(u, /^(https?:\/\/|file:[0-9a-f]{64}$|$)/, `url ${JSON.stringify(u)}`);
  for (const scheme of Object.values(URL_SCHEMES)) assert.ok(!hrefs.includes(scheme) || /^https?:/i.test(scheme), scheme);
  const r = (await d.call("rows", { action: "get", row })).row.properties;
  assert.ok(r.Link === null || /^(https?|mailto|tel):/i.test(r.Link));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.constructor, Object);
});
