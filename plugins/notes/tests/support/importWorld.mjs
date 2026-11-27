import assert from "node:assert/strict";
import { load } from "./build.mjs";

const M = await load();
const { Y, model } = M;

export const WS = "ws0000000001";
export const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const hex = (id) => id.replace(/-/g, "");
export const wrap = (value) => ({ value: { value, role: "editor" } });
export const SPACE = "11111111-1111-4111-8111-111111111111";
export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
export const enc = (s) => new TextEncoder().encode(s);

export function block(id, type, extra = {}) {
  return { id, type, alive: true, space_id: SPACE, created_time: 1700000000000, last_edited_time: 1700000500000, ...extra };
}

export function makeRecords({ body = "hello from notion", rows = [u(301), u(302)], homeContent = [u(2), u(60)], extraBlocks = [] } = {}) {
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

export function memorySink(tree = new Y.Doc()) {
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

export const recordsReader = (contents) => ({ read: async (path) => contents.get(path), size: (path) => contents.get(path)?.length ?? 0 });

export async function recordsImport(s, records, reader = recordsReader(new Map())) {
  const id = M.notionRecordId(records.spaceId);
  const previous = M.readImports(s.tree).find((r) => r.id === id);
  const result = await M.importNotionRecords(records, s.sink, reader, { workspace: WS, files: previous?.files, now: 1_800_000_000_000 });
  M.recordImport(s.tree, { id, source: "notion", at: 1, roots: result.roots, pages: result.pageIds, by: "tester", files: result.files });
  return result;
}

export function memoryVfs(files, { fail = () => false } = {}) {
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

export async function zipImport(s, files, options = {}) {
  const plan = await M.planFor(options.source ?? "notion", memoryVfs(files, options));
  const sync = (options.source ?? "notion") === "notion" ? { workspace: WS, candidates: M.readImports(s.tree) } : undefined;
  const result = await M.writePlan(plan, s.sink, { title: "Notion import", icon: "📥" }, () => {}, () => false, 1_800_000_000_000, { sync });
  if (result.recordId) M.recordImport(s.tree, { id: result.recordId, source: "notion", at: 1, roots: [result.root], pages: result.pageIds, by: "tester", files: result.files });
  return result;
}

export const livePages = (tree) => model.allPages(tree).filter((p) => !p.deleted && !p.archivedAt);
export const pageTitled = (tree, title) => {
  const found = livePages(tree).filter((p) => p.title === title);
  assert.equal(found.length, 1, `one live page titled ${title}, found ${found.length}`);
  return found[0];
};
export const textOf = (doc) => model.plainText(model.blocksOf(doc));

export function addParagraph(doc, text) {
  const group = model.blocksOf(doc).get(0);
  const box = new Y.XmlElement("blockContainer");
  box.setAttribute("id", `local-${text.length}`);
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  box.insert(0, [p]);
  group.insert(group.length, [box]);
}


export function merge(a, b) {
  Y.applyUpdate(a.tree, Y.encodeStateAsUpdate(b.tree));
  Y.applyUpdate(b.tree, Y.encodeStateAsUpdate(a.tree));
  for (const [id, doc] of b.docs) {
    const mine = a.docs.get(id) ?? a.sink.newDoc(id);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(mine));
    M.reconcileSeeds(mine);
    M.reconcileSeeds(doc);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(mine));
    assert.deepEqual(doc.getXmlFragment("blocks").toJSON(), mine.getXmlFragment("blocks").toJSON(), `page ${id} converges`);
  }
}
