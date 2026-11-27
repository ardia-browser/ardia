import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./support/build.mjs";

const M = await load();
const { Y, model } = M;

const WS = "ws0000000001";
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (id) => id.replace(/-/g, "");
const wrap = (value) => ({ value: { value, role: "editor" } });
const SPACE = "11111111-1111-4111-8111-111111111111";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const enc = (s) => new TextEncoder().encode(s);

function block(id, type, extra = {}) {
  return { id, type, alive: true, space_id: SPACE, created_time: 1700000000000, last_edited_time: 1700000500000, ...extra };
}

function makeRecords({ body = "hello from notion", rows = [u(301), u(302)], homeContent = [u(2), u(60)], extraBlocks = [] } = {}) {
  const blocks = {};
  const add = (b) => (blocks[b.id] = wrap(b));
  add(block(u(1), "page", { parent_table: "space", parent_id: SPACE, properties: { title: [["Home"]] }, content: homeContent }));
  add(block(u(2), "text", { properties: { title: [[body]] } }));
  add(block(u(60), "collection_view", { parent_table: "block", parent_id: u(1), collection_id: u(100), view_ids: [u(200)] }));
  for (const id of rows) add(block(id, "page", { parent_table: "collection", parent_id: u(100), properties: { title: [[`Row ${id.slice(-3)}`]] } }));
  for (const b of extraBlocks) add(b);
  const collections = { [u(100)]: wrap({ id: u(100), alive: true, name: [["Tasks"]], parent_id: u(60), parent_table: "block", schema: { title: { name: "Name", type: "title" } } }) };
  const views = { [u(200)]: wrap({ id: u(200), alive: true, type: "table", name: "All" }) };
  return { spaceId: SPACE, rootIds: [u(1)], blocks, collections, views, users: {}, rows: { [u(100)]: rows }, files: {} };
}

function memorySink(tree = new Y.Doc()) {
  const docs = new Map();
  const stored = new Map();
  const sink = {
    tree,
    by: "tester",
    newDoc: (page) => {
      const doc = new Y.Doc();
      docs.set(page, doc);
      return doc;
    },
    doc: async (page) => docs.get(page) ?? sink.newDoc(page),
    putFile: async (bytes, ext) => {
      const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      stored.set(sha, { bytes, ext });
      return sha;
    },
    hasFile: async (sha, size) => stored.get(sha)?.bytes.length === size,
    flush: async () => undefined,
    alive: () => true,
  };
  return { sink, tree, docs, stored };
}

const recordsReader = (contents) => ({ read: async (path) => contents.get(path), size: (path) => contents.get(path)?.length ?? 0 });

async function recordsImport(s, records, reader = recordsReader(new Map())) {
  const id = M.notionRecordId(records.spaceId);
  const previous = M.readImports(s.tree).find((r) => r.id === id);
  const result = await M.importNotionRecords(records, s.sink, reader, { workspace: WS, files: previous?.files, now: 1_800_000_000_000 });
  M.recordImport(s.tree, { id, source: "notion", at: 1, roots: result.roots, pages: result.pageIds, by: "tester", files: result.files });
  return result;
}

function memoryVfs(files, { fail = () => false } = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? enc(v) : v]));
  return {
    files: [...map].map(([path, data]) => ({ path, size: data.length })),
    read: async (path) => {
      if (fail(path)) throw new Error(`reading ${path} failed`);
      const data = map.get(path);
      if (!data) throw new Error(`${path} isn't in the export`);
      return data;
    },
  };
}

async function zipImport(s, files, options = {}) {
  const plan = await M.planFor(options.source ?? "notion", memoryVfs(files, options));
  const sync = (options.source ?? "notion") === "notion" ? { workspace: WS, candidates: M.readImports(s.tree) } : undefined;
  const result = await M.writePlan(plan, s.sink, { title: "Notion import", icon: "📥" }, () => {}, () => false, 1_800_000_000_000, { sync });
  if (result.recordId) M.recordImport(s.tree, { id: result.recordId, source: "notion", at: 1, roots: [result.root], pages: result.pageIds, by: "tester", files: result.files });
  return result;
}

const livePages = (tree) => model.allPages(tree).filter((p) => !p.deleted && !p.archivedAt);
const pageTitled = (tree, title) => {
  const found = livePages(tree).filter((p) => p.title === title);
  assert.equal(found.length, 1, `one live page titled ${title}, found ${found.length}`);
  return found[0];
};
const textOf = (doc) => model.plainText(model.blocksOf(doc));

function addParagraph(doc, text) {
  const group = model.blocksOf(doc).get(0);
  const box = new Y.XmlElement("blockContainer");
  box.setAttribute("id", `local-${text.length}`);
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  box.insert(0, [p]);
  group.insert(group.length, [box]);
}

const HOME = `Home ${hex(u(1))}.md`;

test("1: re-importing unchanged Notion records keeps a local edit to the page body", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "my local note");
  const again = await recordsImport(s, makeRecords());
  assert.match(textOf(s.docs.get(home.id)), /my local note/, "the local edit survives an unchanged source");
  assert.equal(again.conflicts ?? 0, 0);
});

test("1: a Notion change to a page edited here keeps the local edit and counts a conflict, and an untouched page takes the change", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "my local note");
  const changed = await recordsImport(s, makeRecords({ body: "rewritten in notion" }));
  const text = textOf(s.docs.get(home.id));
  assert.match(text, /my local note/);
  assert.equal(changed.conflicts, 1, "the clash is counted");

  const t = memorySink();
  await recordsImport(t, makeRecords());
  await recordsImport(t, makeRecords({ body: "rewritten in notion" }));
  const fresh = textOf(t.docs.get(pageTitled(t.tree, "Home").id));
  assert.match(fresh, /rewritten in notion/);
  assert.doesNotMatch(fresh, /hello from notion/);
});

test("1: re-importing an unchanged Notion zip keeps a local edit, and a page that fails to read keeps its body", async () => {
  const files = { [HOME]: "# Home\n\nhello from the zip\n" };
  const s = memorySink();
  await zipImport(s, files);
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "zip local note");
  await zipImport(s, files);
  assert.match(textOf(s.docs.get(home.id)), /zip local note/);

  const t = memorySink();
  await zipImport(t, files);
  const id = pageTitled(t.tree, "Home").id;
  const result = await zipImport(t, files, { fail: (path) => path === HOME });
  assert.match(textOf(t.docs.get(id)), /hello from the zip/, "a failed read never writes an empty body");
  assert.ok(result.skipped >= 1);
});

test("5: a partial Notion crawl doesn't trash rows or pages it didn't read", async () => {
  const s = memorySink();
  const child = block(u(36), "page", { parent_table: "block", parent_id: u(1), properties: { title: [["Child"]] } });
  await recordsImport(s, makeRecords({ rows: [u(301), u(302), u(303)], homeContent: [u(2), u(60), u(36)], extraBlocks: [child] }));
  const row = pageTitled(s.tree, "Row 302");
  const kid = pageTitled(s.tree, "Child");
  const partial = makeRecords({ rows: [u(301), u(303)], homeContent: [u(2), u(60), u(36)] });
  partial.incomplete = { collections: [u(100)], blocks: [u(36)] };
  await recordsImport(s, partial);
  assert.equal(model.getPage(s.tree, row.id).archivedAt, 0, "a row past the crawl's limit stays");
  assert.equal(model.getPage(s.tree, kid.id).archivedAt, 0, "a page whose record wasn't read stays");

  const complete = makeRecords({ rows: [u(301), u(303)], homeContent: [u(2), u(60)] });
  await recordsImport(s, complete);
  assert.ok(model.getPage(s.tree, row.id).archivedAt > 0, "a complete crawl still trashes what's gone");
});

test("6: the same Notion page imported from a zip and from records is one page", async () => {
  const s = memorySink();
  await zipImport(s, { [HOME]: "# Home\n\nfrom the zip\n" });
  const fromZip = pageTitled(s.tree, "Home");
  await recordsImport(s, makeRecords());
  const both = pageTitled(s.tree, "Home");
  assert.equal(both.id, fromZip.id);

  const r = memorySink();
  await recordsImport(r, makeRecords());
  const fromRecords = pageTitled(r.tree, "Home");
  await zipImport(r, { [HOME]: "# Home\n\nfrom the zip\n" });
  assert.equal(pageTitled(r.tree, "Home").id, fromRecords.id, "an older records import is recognised by a later zip");
});

function merge(a, b) {
  Y.applyUpdate(a.tree, Y.encodeStateAsUpdate(b.tree));
  Y.applyUpdate(b.tree, Y.encodeStateAsUpdate(a.tree));
  for (const [id, doc] of b.docs) {
    const mine = a.docs.get(id) ?? a.sink.newDoc(id);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
  }
}

test("6: two Macs importing the same zip for the first time at once end with one root and one copy of each body", async () => {
  const files = { [HOME]: "# Home\n\nonly once\n" };
  const a = memorySink();
  const b = memorySink();
  await zipImport(a, files);
  await zipImport(b, files);
  merge(a, b);
  assert.equal(livePages(a.tree).filter((p) => p.title === "Notion import").length, 1, "one root");
  const home = pageTitled(a.tree, "Home");
  assert.equal(textOf(a.docs.get(home.id)).match(/only once/g)?.length, 1, "the body isn't doubled");

  const c = memorySink();
  const d = memorySink();
  await recordsImport(c, makeRecords());
  await recordsImport(d, makeRecords());
  merge(c, d);
  assert.equal(textOf(c.docs.get(pageTitled(c.tree, "Home").id)).match(/hello from notion/g)?.length, 1);
});

test("7: relative attachments with the same name in different folders keep their own bytes", async () => {
  const s = memorySink();
  const one = new Uint8Array([...PNG, 1]);
  const two = new Uint8Array([...PNG, 2]);
  await zipImport(s, { "A/note.md": "# A\n\n![](photo.png)\n", "A/photo.png": one, "B/note.md": "# B\n\n![](photo.png)\n", "B/photo.png": two }, { source: "markdown" });
  const urls = livePages(s.tree)
    .filter((p) => p.title === "note")
    .map((p) => JSON.stringify(model.blocksOf(s.docs.get(p.id)).toJSON()).match(/file:([0-9a-f]{64})/)?.[1]);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1], "each page points at its own photo");
});

test("7: a records attachment replaced with different bytes of the same size is read again", async () => {
  const key = "attachment:aaaaaaaa-0000-4000-8000-000000000001:pic.png";
  const image = block(u(3), "image", { properties: { source: [[key]] } });
  const recs = () => {
    const r = makeRecords({ homeContent: [u(2), u(3), u(60)], extraBlocks: [image] });
    r.files[key] = { path: "files/pic.png", name: "pic.png", size: PNG.length + 1 };
    return r;
  };
  const s = memorySink();
  await recordsImport(s, recs(), recordsReader(new Map([["files/pic.png", new Uint8Array([...PNG, 1])]])));
  await recordsImport(s, recs(), recordsReader(new Map([["files/pic.png", new Uint8Array([...PNG, 2])]])));
  const want = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array([...PNG, 2]))).toString("hex");
  const home = pageTitled(s.tree, "Home");
  assert.match(JSON.stringify(model.blocksOf(s.docs.get(home.id)).toJSON()), new RegExp(`file:${want}`), "the new bytes are used");
});
