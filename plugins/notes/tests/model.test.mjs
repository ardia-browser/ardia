import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, rng } from "./support/build.mjs";

const M = await load();
const { Y, model, protocol, bytes } = M;

test("pages: create, order, move, archive, restore, delete", () => {
  const tree = new Y.Doc();
  const a = model.createPage(tree, { parent: "", kind: "page", title: "A", by: "d1" });
  const b = model.createPage(tree, { parent: "", kind: "page", title: "B", by: "d1" });
  const first = model.createPage(tree, { parent: "", kind: "page", title: "First", after: null, by: "d1" });
  const mid = model.createPage(tree, { parent: "", kind: "page", title: "Mid", after: a, by: "d1" });
  assert.deepEqual(model.childrenOf(tree, "").map((p) => p.title), ["First", "A", "Mid", "B"]);
  const child = model.createPage(tree, { parent: a, kind: "page", title: "Child", by: "d1" });
  assert.deepEqual(model.ancestorsOf(tree, child).map((p) => p.title), ["A"]);
  assert.equal(model.movePage(tree, a, child, undefined, "d1"), false);
  assert.equal(model.movePage(tree, b, a, null, "d1"), true);
  assert.deepEqual(model.childrenOf(tree, a).map((p) => p.title), ["B", "Child"]);
  model.archivePage(tree, a, "d1");
  assert.equal(model.isArchivedDeep(tree, child), true);
  model.restorePage(tree, a, "d1");
  assert.equal(model.isArchivedDeep(tree, child), false);
  const doomed = model.deletePage(tree, a, "d1");
  assert.deepEqual(new Set(doomed), new Set([a, b, child]));
  assert.equal(model.getPage(tree, child).deleted, true);
  assert.deepEqual(model.childrenOf(tree, "").map((p) => p.title), ["First", "Mid"]);
  assert.ok(first && mid);
});

test("orderBetween always sorts between its neighbours", () => {
  const random = rng(7);
  let keys = [model.orderBetween(null, null)];
  for (let i = 0; i < 400; i++) {
    const at = Math.floor(random() * (keys.length + 1));
    const key = model.orderBetween(keys[at - 1] ?? null, keys[at] ?? null);
    if (at > 0) assert.ok(keys[at - 1] < key, `${keys[at - 1]} < ${key}`);
    if (at < keys.length) assert.ok(key < keys[at], `${key} < ${keys[at]}`);
    keys.splice(at, 0, key);
  }
  assert.deepEqual([...keys].sort(), keys);
});

test("slugs and paths", () => {
  assert.equal(model.slug("Crème brûlée: a recipe!"), "Creme-brulee-a-recipe");
  assert.equal(model.slug(""), "Untitled");
  assert.equal(model.pagePath({ id: "0123456789ab", title: "Hello World" }), "/Hello-World-0123456789ab");
  assert.equal(model.pageIdFromPath("/Hello-World-0123456789ab?v=x"), "0123456789ab");
  assert.equal(model.pageIdFromPath("/0123456789ab"), "0123456789ab");
  assert.equal(model.pageIdFromPath("/search"), null);
});

test("base64 matches Buffer for every length", () => {
  const random = rng(3);
  for (let n = 0; n < 300; n++) {
    const data = new Uint8Array(n).map(() => Math.floor(random() * 256));
    const ours = bytes.toBase64(data);
    assert.equal(ours, Buffer.from(data).toString("base64"));
    assert.deepEqual([...bytes.fromBase64(ours)], [...data]);
  }
  const big = new Uint8Array(200_000).map((_, i) => (i * 31) & 255);
  assert.equal(bytes.toBase64(big), Buffer.from(big).toString("base64"));
});

test("sha256 matches node", () => {
  const random = rng(11);
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const data = new Uint8Array(n).map(() => Math.floor(random() * 256));
    const ours = Buffer.from(new M.Sha256().update(data.subarray(0, n >> 1)).update(data.subarray(n >> 1)).digest()).toString("hex");
    assert.equal(ours, createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});

test("log records round trip and stop at a partial tail", () => {
  const a = M.encodeRecord(new Uint8Array([1, 2, 3]));
  const b = M.encodeRecord(new Uint8Array(300).fill(9));
  const joined = new Uint8Array([...a, ...b]);
  const whole = M.decodeRecords(joined);
  assert.equal(whole.records.length, 2);
  assert.equal(whole.consumed, joined.length);
  const cut = M.decodeRecords(joined.subarray(0, joined.length - 5));
  assert.equal(cut.records.length, 1);
  assert.equal(cut.consumed, a.length);
  assert.equal(cut.damaged, 0);
  const bad = M.decodeRecords(new Uint8Array([0xa5, 0x4e, 0x4c, 0x52, 0, 0, 0, 0, 1, 2, 3, 4, 5]));
  assert.equal(bad.damaged, 1);
});

test("messages over the limit split into chunks and join back", () => {
  const big = { t: "up", doc: "p:0123456789ab", workspace: "w", u: "x".repeat(500_000), title: "naïve ✓ 🎉 \"quoted\" \\ back".repeat(2000) };
  const pieces = protocol.splitMessage(big, protocol.PAGE_TO_MAIN_MAX, "c1");
  assert.ok(pieces.length > 8);
  for (const p of pieces) assert.ok(Buffer.byteLength(JSON.stringify(p)) <= protocol.PAGE_TO_MAIN_MAX, "piece fits");
  const r = new protocol.Reassembler();
  let out;
  const shuffled = [...pieces].reverse();
  for (const p of shuffled) out = r.push(p) ?? out;
  assert.deepEqual(out, big);
  const small = { t: "hello" };
  assert.deepEqual(protocol.splitMessage(small, 100, "c2"), [small]);
  assert.equal(r.push({ t: "chunk", id: "x", i: 5, n: 2, data: "" }), undefined);
});

test("plainText reads BlockNote blocks", () => {
  const doc = new Y.Doc();
  M.writeBlocks(doc, M.GETTING_STARTED);
  const text = model.plainText(model.blocksOf(doc));
  assert.match(text, /Welcome to Notes/);
  assert.match(text, /Callouts make a note stand out/);
  assert.match(text, /Toggles hide details/);
  assert.match(text, /Like this/);
});

test("doc ids map between the wire and the disk", () => {
  assert.equal(protocol.diskDocName("ws"), "ws");
  assert.equal(protocol.diskDocName("p:0123456789ab"), "p-0123456789ab");
  assert.equal(protocol.wireDocId("p-0123456789ab"), "p:0123456789ab");
  assert.equal(protocol.pageOfDoc("p:0123456789ab"), "0123456789ab");
});

test("page reads stay current inside and after transactions while a large tree is read cheaply", () => {
  const tree = new Y.Doc();
  const root = model.createPage(tree, { parent: "", kind: "page", title: "Root", by: "me" });
  for (let i = 0; i < 2000; i++) model.createPage(tree, { parent: i % 2 ? root : "", kind: "page", title: `P${i}`, by: "me" });
  assert.equal(model.childrenOf(tree, root).length, 1000);
  tree.transact(() => {
    const id = model.createPage(tree, { parent: root, kind: "page", title: "Inside", by: "me" });
    assert.equal(model.getPage(tree, id)?.title, "Inside");
    assert.equal(model.childrenOf(tree, root).length, 1001);
  });
  assert.equal(model.childrenOf(tree, root).length, 1001);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(tree));
  assert.equal(model.childrenOf(remote, root).length, 1001);
  const late = model.createPage(tree, { parent: root, kind: "page", title: "Late", by: "me" });
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(tree));
  assert.equal(model.getPage(remote, late)?.title, "Late");
  model.updatePage(remote, late, { title: "Renamed" }, "me");
  assert.equal(model.getPage(remote, late)?.title, "Renamed");
  const seen = [];
  model.pagesOf(remote).observeDeep(() => seen.push(model.childrenOf(remote, root).length));
  model.createPage(remote, { parent: root, kind: "page", title: "Observed", by: "me" });
  assert.deepEqual(seen, [1003], "observers read the change they're told about");
  const start = performance.now();
  for (let i = 0; i < 500; i++) model.childrenOf(remote, root);
  assert.ok(performance.now() - start < 250, `500 reads of a 2,000-page tree took ${Math.round(performance.now() - start)} ms`);
});
