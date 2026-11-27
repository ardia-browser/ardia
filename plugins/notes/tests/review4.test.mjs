import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

const tempDir = () => mkdtempSync(join(tmpdir(), "notes-review4-"));
const b64 = (u) => Buffer.from(u).toString("base64");

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
      store: { debounceMs: bootOptions.debounceMs ?? 5, rescanMs: 0, compactAt: bootOptions.compactAt },
      log: () => {},
    });
    hub.attach(notes);
    const pages = [];
    const instance = {
      files,
      folders,
      hub,
      notes,
      open(view) {
        const p = hub.open(view, { storage: pageStorage });
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

function dependentPair() {
  const source = new Y.Doc();
  source.clientID = 515151;
  source.getMap("edits").set("first", 1);
  const first = Y.encodeStateAsUpdate(source);
  const sv = Y.encodeStateVector(source);
  source.getMap("edits").set("second", 2);
  return { first, second: Y.encodeStateAsUpdate(source, sv) };
}

const acks = (view, seq) => view.received.filter((m) => m.t === "ack" && m.seq === seq);
const journalKeys = (map) => [...map.keys()].filter((k) => k.startsWith("ardia-notes-journal|"));

test("A1: an update waiting on its dependency is written verbatim, acked, and survives a crash", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  const view = first.open("v1");
  await view.client.ready;
  const pair = dependentPair();
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(pair.second), seq: 7001 });
  await until(() => acks(view, 7001).length === 1, 3000, "acked once on disk");
  await first.crash();
  const second = w.boot();
  await ready(second);
  const doc = await second.notes.spaceStore(ws.id).get(`p-${page}`);
  Y.applyUpdate(doc, pair.first);
  assert.equal(doc.getMap("edits").get("second"), 2, "the pending update came back from disk");
});

test("A2: compaction keeps updates that are still waiting on a dependency", async () => {
  const dir = tempDir();
  const open = async () => {
    const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "mine", debounceMs: 2, rescanMs: 0, compactAt: 1 });
    cleanups.push(() => s.close().catch(() => undefined));
    await s.open();
    return s;
  };
  const a = await open();
  await a.get(PAGE);
  const pair = dependentPair();
  assert.equal(await a.applyFromPage(PAGE, pair.second, "page"), true);
  await a.whenIdle();
  await a.close();
  const b = await open();
  const doc = await b.get(PAGE);
  Y.applyUpdate(doc, pair.first);
  assert.equal(doc.getMap("edits").get("second"), 2);
});

test("A3: an append that fails once and then succeeds is acked", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  const view = first.open("v1");
  await view.client.ready;
  let failOnce = true;
  first.files.faults.append = (_root, path) => (failOnce && path.endsWith(".log") ? ((failOnce = false), -1) : null);
  const extra = new Y.Doc();
  extra.getMap("edits").set("retry", true);
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(Y.encodeStateAsUpdate(extra)), seq: 7101 });
  await until(() => acks(view, 7101).length === 1, 5000, "acked after the retry");
});

test("A4: legacy journal arrays are split into per-update entries before the legacy key goes", async () => {
  const w = world();
  const first = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  const one = new Y.Doc();
  one.getMap("edits").set("legacyOne", true);
  const two = new Y.Doc();
  two.getMap("edits").set("legacyTwo", true);
  w.pageStorage.set(`ardia-notes-unacked:${ws.id}:p:${page}`, JSON.stringify([b64(Y.encodeStateAsUpdate(one)), b64(Y.encodeStateAsUpdate(two))]));
  const view = first.open("v1");
  await view.client.ready;
  await until(() => journalKeys(w.pageStorage).length === 2, 3000, "split into two entries");
  assert.ok(![...w.pageStorage.keys()].some((k) => k.startsWith("ardia-notes-unacked:")), "legacy key gone only after the split");
  await first.crash();
  const second = w.boot();
  await ready(second);
  const again = second.open("v2");
  await again.client.ready;
  await until(async () => {
    const doc = await second.notes.spaceStore(ws.id).get(`p-${page}`);
    return doc.getMap("edits").get("legacyOne") && doc.getMap("edits").get("legacyTwo");
  }, 5000, "both legacy edits arrive");
  await until(() => journalKeys(w.pageStorage).length === 0, 5000, "journal clears on ack");
});

test("B: an edit is journaled the moment it happens", async () => {
  const w = world();
  const first = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  const view = first.open("v1");
  await view.client.ready;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  h.doc.getMap("edits").set("instant", true);
  assert.equal(journalKeys(w.pageStorage).length, 1, "journaled synchronously");
  view.vanish();
  h.release();
});

test("C: an edit that arrives while its page is being deleted for good is refused", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[2].id;
  const view = first.open("v1");
  await view.client.ready;
  let started = false;
  first.files.faults.delay = (root, path) => (path.includes("history/") ? ((started = true), 300) : 0);
  const edit = new Y.Doc();
  edit.getMap("edits").set("late", true);
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(Y.encodeStateAsUpdate(edit)), seq: 7301 });
  await until(() => started, 3000, "the apply is waiting on its history snapshot");
  await first.notes.call("deletePage", { workspace: ws.id, page });
  await until(() => acks(view, 7301).length === 1, 3000, "answered");
  assert.equal(acks(view, 7301)[0].outcome, "refused");
  const doc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  assert.equal(doc.getMap("edits").get("late"), undefined);
});

test("D1: a remote device compacting doesn't count its snapshot and old log together", async () => {
  const dir = tempDir();
  const remoteDir = tempDir();
  const remote = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: remoteDir }), "data", "ws1"), deviceId: "remote", debounceMs: 2, rescanMs: 0, compactAt: 256 * 1024 });
  cleanups.push(() => remote.close().catch(() => undefined));
  await remote.open();
  const doc = await remote.get(PAGE);
  for (let i = 0; i < 40; i++) {
    doc.getText("t").insert(0, "x".repeat(1000));
    await remote.flush();
  }
  await remote.whenIdle();
  const target = join(dir, "ws1/docs", PAGE);
  mkdirSync(target, { recursive: true });
  cpSync(join(remoteDir, "ws1/docs", PAGE), target, { recursive: true });
  const reader = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "reader", rescanMs: 0, maxDocBytes: 70 * 1024 });
  cleanups.push(() => reader.close().catch(() => undefined));
  await reader.open();
  await reader.get(PAGE);
  const compacting = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: remoteDir }), "data", "ws1"), deviceId: "remote", debounceMs: 2, rescanMs: 0, compactAt: 1 });
  cleanups.push(() => compacting.close().catch(() => undefined));
  await remote.close();
  await compacting.open();
  (await compacting.get(PAGE)).getMap("m").set("after", true);
  await compacting.whenIdle();
  cpSync(join(remoteDir, "ws1/docs", PAGE, "remote.snap"), join(target, "remote.snap"));
  await reader.rescan();
  cpSync(join(remoteDir, "ws1/docs", PAGE, "remote.log"), join(target, "remote.log"));
  await reader.rescan();
  assert.deepEqual(reader.rejected(), []);
  assert.equal((await reader.get(PAGE)).getMap("m").get("after"), true);
});

test("D2: a document set aside for size is taken back when its files shrink", async () => {
  const dir = tempDir();
  const remoteDir = tempDir();
  const write = async (text, compactAt) => {
    const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: remoteDir }), "data", "ws1"), deviceId: "remote", debounceMs: 2, rescanMs: 0, compactAt });
    await s.open();
    const d = await s.get(PAGE);
    d.getText("t").delete(0, d.getText("t").length);
    d.getText("t").insert(0, text);
    await s.whenIdle();
    await s.close();
  };
  await write("y".repeat(90_000), 1);
  const target = join(dir, "ws1/docs", PAGE);
  mkdirSync(target, { recursive: true });
  cpSync(join(remoteDir, "ws1/docs", PAGE), target, { recursive: true });
  const reader = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "reader", rescanMs: 0, maxDocBytes: 64 * 1024 });
  cleanups.push(() => reader.close().catch(() => undefined));
  await reader.open();
  await reader.get(PAGE);
  assert.ok(reader.rejected().includes(PAGE));
  rmSync(target, { recursive: true });
  const small = new Y.Doc();
  small.getText("t").insert(0, "small now");
  mkdirSync(target, { recursive: true });
  const fs = M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1");
  await fs.write(`docs/${PAGE}/other.snap`, Y.encodeStateAsUpdate(small));
  await reader.rescan();
  assert.deepEqual(reader.rejected(), []);
  assert.equal((await reader.get(PAGE)).getText("t").toString(), "small now");
});

test("E1: moving a page to another workspace while the source is being shared loses nothing", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const other = await first.notes.call("createWorkspace", { name: "Other" });
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  first.files.faults.delay = (root, path) => (root !== "data" && path.includes("docs/") ? 40 : 0);
  const sharing = first.notes.call("shareWorkspace", { workspace: ws.id });
  await until(() => first.notes.workspaces().length && true);
  const moving = first.notes.call("movePage", { workspace: ws.id, page, parent: "", toWorkspace: other.id });
  const [shared, moved] = await Promise.all([sharing, moving]);
  first.files.faults.delay = undefined;
  assert.equal(shared.ok, true);
  assert.equal(moved.workspace, other.id);
  assert.equal(model.getPage(first.notes.treeOf(other.id), page)?.title, "Getting Started");
  assert.equal(model.getPage(first.notes.treeOf(ws.id), page)?.deleted, true);
  const doc = await first.notes.spaceStore(other.id).get(`p-${page}`);
  assert.match(model.plainText(model.blocksOf(doc)), /Welcome to Notes/);
});

test("E2: a shared copy whose content differs is caught before the switch and nothing is reported ok", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  first.files.faults.mutate = (root, path, data) => {
    if (root === "data" || !path.endsWith(`docs/p-${page}/${first.notes.deviceId}.snap`)) return data;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, data);
    const blocks = model.blocksOf(doc);
    blocks.delete(0, blocks.length);
    return Y.encodeStateAsUpdate(doc);
  };
  await assert.rejects(first.notes.call("shareWorkspace", { workspace: ws.id }), /copy/);
  first.files.faults.mutate = undefined;
  const info = first.notes.workspaces()[0];
  assert.equal(info.shared, false);
  assert.ok(!w.storage.get("workspaces").some((r) => r.shared));
  const doc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  assert.match(model.plainText(model.blocksOf(doc)), /Welcome to Notes/);
  assert.deepEqual(readdirSync(join(w.dir, "shared")).filter((f) => existsSync(join(w.dir, "shared", f, "workspace.json"))), []);
});

test("sameContent sees deletions that leave the state vector alone", () => {
  const a = new Y.Doc();
  a.getText("t").insert(0, "hello world");
  const before = Y.encodeStateAsUpdate(a);
  a.getText("t").delete(0, 6);
  const after = Y.encodeStateAsUpdate(a);
  assert.equal(M.sameContent(before, before), true);
  assert.equal(M.sameContent(before, after), false);
});
