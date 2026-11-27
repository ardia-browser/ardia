import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";

const M = await load();
const { Y, model } = M;
const PAGE = "p-aaaaaaaaaaaa";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const tempDir = () => mkdtempSync(join(tmpdir(), "notes-review5-"));
const b64 = (u) => Buffer.from(u).toString("base64");
const journalKeys = (map) => [...map.keys()].filter((k) => k.startsWith("ardia-notes-journal|"));

function world() {
  const dir = tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  const storage = new Map();
  const pageStorage = new Map();
  const boot = (bootOptions = {}) => {
    const files = M.nodeFiles({ data: join(dir, "data") });
    const folders = M.fakeFolders(files, join(dir, "shared"));
    const hub = M.pageHub();
    const notes = new M.Notes({
      files,
      folders,
      storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
      setting: () => undefined,
      post: hub.post,
      openPage: async () => {},
      openUrl: async () => {},
      store: { debounceMs: bootOptions.debounceMs ?? 5, rescanMs: 0 },
      existenceWaitMs: 200,
      durableTimeoutMs: 5000,
      log: () => {},
    });
    hub.attach(notes);
    const pages = [];
    const instance = {
      files,
      hub,
      notes,
      open(view, openOptions = {}) {
        const p = hub.open(view, { storage: pageStorage, ...openOptions });
        pages.push(p);
        return p;
      },
      async crash() {
        for (const p of pages) p.vanish();
        await notes.stop({ flush: false });
        files.detach();
      },
      async stop() {
        for (const p of pages) p.close();
        await notes.stop();
        files.detach();
      },
    };
    cleanups.push(() => instance.stop().catch(() => undefined));
    return instance;
  };
  return { dir, storage, pageStorage, boot };
}

async function ready(instance) {
  await instance.notes.start();
  await until(() => instance.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  await instance.notes.whenIdle();
  return instance.notes.workspaces();
}

const acks = (view, seq) => view.received.filter((m) => m.t === "ack" && m.seq === seq);

test("1: a late ack from an earlier load doesn't clear a new edit with the same seq", async () => {
  const w = world();
  const first = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  await first.notes.spaceStore(ws.id).flush();
  const old = first.open("v1");
  await old.client.ready;
  const a = old.client.open(ws.id, `p:${page}`);
  await a.synced;
  a.doc.getMap("edits").set("old", true);
  const mainDoc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("edits").get("old") === true, 3000, "old edit applied");
  old.vanish();
  const fresh = first.open("v1");
  await fresh.client.ready;
  const b = fresh.client.open(ws.id, `p:${page}`);
  await b.synced;
  b.doc.getMap("edits").set("fresh", true);
  await first.notes.spaceStore(ws.id).flush(`p-${page}`);
  await until(() => fresh.received.some((m) => m.t === "ack"), 3000, "an ack reached the reused view");
  await first.crash();
  const second = w.boot();
  await ready(second);
  const again = second.open("v2");
  await again.client.ready;
  await until(async () => (await second.notes.spaceStore(ws.id).get(`p-${page}`)).getMap("edits").get("fresh") === true, 5000, "the new edit survives");
});

test("2: a doc set aside for a remote device's size still loads and keeps this Mac's own log", async () => {
  const dir = tempDir();
  const mine = async () => {
    const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "mine", debounceMs: 2, rescanMs: 0, maxDocBytes: 32 * 1024 });
    cleanups.push(() => s.close().catch(() => undefined));
    await s.open();
    return s;
  };
  const a = await mine();
  (await a.get(PAGE)).getMap("m").set("mine", "kept");
  await a.close();
  writeFileSync(join(dir, "ws1/docs", PAGE, "remote.log"), Buffer.alloc(100 * 1024, 7));
  const b = await mine();
  await b.rescan();
  const doc = await b.get(PAGE);
  assert.equal(doc.getMap("m").get("mine"), "kept", "our own log was read");
  doc.getMap("m").set("more", 1);
  await b.whenIdle();
  await b.close();
  const log = readFileSync(join(dir, "ws1/docs", PAGE, "mine.log"));
  const c = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "mine", rescanMs: 0, maxDocBytes: 32 * 1024 });
  cleanups.push(() => c.close().catch(() => undefined));
  await c.open();
  const back = await c.get(PAGE);
  assert.equal(back.getMap("m").get("mine"), "kept", `log is ${log.length} bytes`);
  assert.equal(back.getMap("m").get("more"), 1);
});

test("3: sameContent catches missing pending updates and different bytes under the same ids", () => {
  const base = new Y.Doc();
  base.clientID = 1;
  base.getText("t").insert(0, "hello");
  const state = Y.encodeStateAsUpdate(base);
  const other = new Y.Doc();
  other.clientID = 2;
  other.getMap("m").set("a", 1);
  const sv = Y.encodeStateVector(other);
  other.getMap("m").set("b", 2);
  const dependent = Y.encodeStateAsUpdate(other, sv);
  const withPending = new Y.Doc();
  Y.applyUpdate(withPending, state);
  Y.applyUpdate(withPending, dependent);
  assert.equal(M.sameContent(M.fullState(withPending), state), false, "a missing pending update differs");
  const bytes = Buffer.from(state);
  const at = bytes.indexOf(Buffer.from("hello"));
  bytes.set(Buffer.from("jello"), at);
  assert.equal(M.sameContent(state, new Uint8Array(bytes)), false, "different bytes under the same ids differ");
  assert.equal(M.sameContent(state, Y.encodeStateAsUpdate(base)), true);
});

test("4a: a move whose destination can't be saved fails and leaves the page where it was", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const other = await inst.notes.call("createWorkspace", { name: "Other" });
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  inst.files.faults.append = (_root, path) => (path.includes(`workspaces/${other.id}/`) ? -1 : null);
  inst.files.faults.write = (_root, path) => path.includes(`workspaces/${other.id}/docs`);
  const start = Date.now();
  await assert.rejects(inst.notes.call("movePage", { workspace: ws.id, page, parent: "", toWorkspace: other.id }), /stayed where it was/);
  assert.ok(Date.now() - start < 40_000);
  assert.equal(model.getPage(inst.notes.treeOf(ws.id), page).deleted, false);
});

test("4b: edits for a moved page sent to its old workspace land in the new one", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const other = await inst.notes.call("createWorkspace", { name: "Other" });
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  await inst.notes.call("movePage", { workspace: ws.id, page, parent: "", toWorkspace: other.id });
  const view = inst.open("v1");
  await view.client.ready;
  const edit = new Y.Doc();
  edit.getMap("edits").set("afterMove", true);
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(Y.encodeStateAsUpdate(edit)), seq: 8401 });
  await until(() => acks(view, 8401).length === 1, 3000, "answered");
  assert.equal(acks(view, 8401)[0].outcome, undefined, "accepted, not refused");
  const doc = await inst.notes.spaceStore(other.id).get(`p-${page}`);
  assert.equal(doc.getMap("edits").get("afterMove"), true);
});

test("5a: deleting a page reports only once the tombstone is on disk", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[2].id;
  let failures = 2;
  inst.files.faults.append = (_root, path) => (failures > 0 && path.endsWith("/docs/ws/" + inst.notes.deviceId + ".log") ? (failures--, -1) : null);
  await inst.notes.call("deletePage", { workspace: ws.id, page });
  const check = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: join(w.dir, "data") }), "data", `workspaces/${ws.id}`), deviceId: "checker", rescanMs: 0 });
  await check.open();
  assert.equal(model.getPage(await check.get("ws"), page).deleted, true);
  await check.close();
});

test("5b: edits for a page that doesn't exist are refused, and title edits can't revive a deleted page", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const view = inst.open("v1");
  await view.client.ready;
  const edit = new Y.Doc();
  edit.getMap("edits").set("ghost", true);
  view.ardia.send({ t: "up", doc: "p:0123456789ab", workspace: ws.id, u: b64(Y.encodeStateAsUpdate(edit)), seq: 8501 });
  await until(() => acks(view, 8501).length === 1, 3000, "answered");
  assert.equal(acks(view, 8501)[0].outcome, "refused");
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[2].id;
  const tree = view.client.open(ws.id, "ws");
  await tree.synced;
  await inst.notes.call("deletePage", { workspace: ws.id, page });
  await until(() => model.getPage(tree.doc, page)?.deleted === true, 3000, "the page sees the delete");
  model.pagesOf(tree.doc).get(page).set("title", "Back from the dead");
  model.pagesOf(tree.doc).get(page).set("deleted", false);
  await until(() => view.sent.some((m) => m.t === "up" && m.doc === "ws"), 3000, "the tree edit went out");
  await inst.notes.whenIdle();
  await view.client.call("search", { query: "x" });
  const meta = model.getPage(inst.notes.treeOf(ws.id), page);
  assert.equal(meta.deleted, true);
  assert.equal(meta.title, "");
  tree.release();
});

test("6a: a batch the helper never got is sent again while the page stays open", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  const view = inst.open("v1", { dropUps: 1, bridge: { resendMs: 200 } });
  await view.client.ready;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  h.doc.getMap("edits").set("dropped", true);
  const mainDoc = await inst.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("edits").get("dropped") === true, 5000, "resent and applied");
  await until(() => view.client.saveState().state === "saved", 5000, "acked");
  h.release();
});

test("6b: a refusal never flashes Saved, and one recorded before mount still toasts", () => {
  assert.deepEqual(M.decideSave("saving", false, 0, { state: "saved", refused: 1 }), { show: "none", fadeAfterSaved: false, toastRefused: true });
  assert.equal(M.decideSave("none", false, 0, { state: "saved", refused: 2 }).toastRefused, true);
  assert.equal(M.decideSave("saving", false, 1, { state: "saved", refused: 1 }).show, "saved");
});

test("7a: the workspace cap holds on the total, not just on growth", async () => {
  const dir = tempDir();
  const docs = join(dir, "ws1/docs");
  for (const [name, fill] of [["p-aaaaaaaaaaaa", 1], ["p-bbbbbbbbbbbb", 2], ["p-cccccccccccc", 3]]) {
    const d = new Y.Doc();
    d.getText("t").insert(0, String(fill).repeat(20_000));
    mkdirSync(join(docs, name), { recursive: true });
    writeFileSync(join(docs, name, "remote.snap"), Y.encodeStateAsUpdate(d));
  }
  const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "reader", rescanMs: 0, maxWorkspaceBytes: 50 * 1024 });
  cleanups.push(() => s.close().catch(() => undefined));
  await s.open();
  await s.rescan();
  await s.loadAll();
  assert.equal(s.rejected().length, 1);
});

test("7b: a remote log rewritten to the same length is read again", async () => {
  const dir = tempDir();
  const target = join(dir, "ws1/docs", PAGE);
  mkdirSync(target, { recursive: true });
  const record = (key) => {
    const d = new Y.Doc();
    d.clientID = 99;
    d.getMap("m").set(key, true);
    return M.encodeRecord(Y.encodeStateAsUpdate(d));
  };
  writeFileSync(join(target, "remote.log"), Buffer.concat([Buffer.from(M.LOG_HEADER), record("aaaa")]));
  const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "reader", rescanMs: 0 });
  cleanups.push(() => s.close().catch(() => undefined));
  await s.open();
  const doc = await s.get(PAGE);
  assert.equal(doc.getMap("m").get("aaaa"), true);
  const other = new Y.Doc();
  other.clientID = 98;
  other.getMap("m").set("bbbb", true);
  writeFileSync(join(target, "remote.log"), Buffer.concat([Buffer.from(M.LOG_HEADER), M.encodeRecord(Y.encodeStateAsUpdate(other))]));
  const { utimesSync } = await import("node:fs");
  utimesSync(join(target, "remote.log"), new Date(), new Date(Date.now() + 5000));
  await s.rescan();
  assert.equal(doc.getMap("m").get("bbbb"), true);
});

test("8a: a same-device journal entry is never dropped for age before it was replayed", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  const old = new Y.Doc();
  old.getMap("edits").set("ancient", true);
  w.pageStorage.set(M.journalKey(inst.notes.deviceId, ws.id, `p:${page}`, "longago", 1), JSON.stringify({ u: b64(Y.encodeStateAsUpdate(old)), at: Date.now() - 90 * 24 * 3600_000 }));
  const view = inst.open("v1");
  await view.client.ready;
  await until(async () => (await inst.notes.spaceStore(ws.id).get(`p-${page}`)).getMap("edits").get("ancient") === true, 3000, "replayed");
});

test("8b: when nothing can keep an edit and memory is full the page says it is blocked", async () => {
  const w = world();
  const inst = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(inst);
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  const view = inst.open("v1", { quotaBytes: 0, bridge: { memoryChars: 1000 } });
  await view.client.ready;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  h.doc.getMap("edits").set("big", "z".repeat(5000));
  assert.equal(view.client.saveState().state, "blocked");
  h.release();
});

test("8c: an update whose dependency never arrives stays unacked past the cap, and the page keeps it", async () => {
  const dir = tempDir();
  const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "mine", debounceMs: 2, rescanMs: 0, maxPendingBytes: 10 });
  cleanups.push(() => s.close().catch(() => undefined));
  await s.open();
  await s.get(PAGE);
  const other = new Y.Doc();
  other.clientID = 7;
  other.getMap("m").set("a", 1);
  const sv = Y.encodeStateVector(other);
  other.getMap("m").set("b", "x".repeat(200));
  const dependent = Y.encodeStateAsUpdate(other, sv);
  assert.equal(await s.applyFromPage(PAGE, dependent, "page"), true, "the first one is kept and written");
  other.getMap("m").set("c", 3);
  assert.equal(await s.applyFromPage(PAGE, Y.encodeStateAsUpdate(other, sv), "page"), false, "past the cap it isn't acked");
});
