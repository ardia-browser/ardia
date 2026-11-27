import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
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

const tempDir = () => mkdtempSync(join(tmpdir(), "notes-review2-"));

function store(dir, id, options = {}) {
  const files = options.files ?? M.nodeFiles({ data: dir });
  const fs = M.ardiaFileStore(files, "data", "ws1", { callMax: options.callMax });
  const errors = [];
  const s = new M.WorkspaceStore({ fs, deviceId: id, debounceMs: 2, rescanMs: 0, compactAt: options.compactAt ?? 256 * 1024, onError: (e, w) => errors.push(`${w}: ${e?.message ?? e}`), ...(options.extra ?? {}) });
  cleanups.push(() => s.close().catch(() => undefined));
  return { files, fs, store: s, errors };
}

function device(options = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, join(dir, "shared"));
  const storage = new Map();
  const hub = M.pageHub(options.hub);
  const host = {
    files,
    folders,
    storage: {
      get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined),
      set: async (k, v) => {
        if (options.failSave?.(k)) throw new Error("storage is full");
        storage.set(k, structuredClone(v));
      },
    },
    setting: () => undefined,
    post: hub.post,
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 5, rescanMs: 200 },
    uploadLimits: options.uploadLimits,
    log: () => {},
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  const pages = [];
  cleanups.push(async () => {
    for (const p of pages) p.close();
    await notes.stop();
    files.detach();
  });
  return {
    dir,
    files,
    notes,
    hub,
    open(view, openOptions) {
      const p = hub.open(view, openOptions);
      pages.push(p);
      return p;
    },
  };
}

async function booted(d) {
  await d.notes.start();
  await until(() => d.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  await d.notes.whenIdle();
  return d.notes.workspaces();
}

test("round 2 #2: a torn first append doesn't hide the record written after it", async () => {
  const dir = tempDir();
  const a = store(dir, "deva");
  await a.store.open();
  let tear = true;
  a.files.faults.append = (_root, path) => (tear && path.endsWith(".log") ? ((tear = false), 2) : null);
  const doc = await a.store.get(PAGE);
  doc.getMap("m").set("one", 1);
  await until(async () => {
    await a.store.whenIdle();
    return !a.store.hasPending();
  }, 5000, "the store recovers");
  doc.getMap("m").set("two", 2);
  await a.store.whenIdle();
  const b = store(dir, "devb");
  await b.store.open();
  const m = (await b.store.get(PAGE)).getMap("m");
  assert.deepEqual([m.get("one"), m.get("two")], [1, 2]);
});

test("round 2 #2b: the size read-back really asks the host", async () => {
  const dir = tempDir();
  const a = store(dir, "deva");
  await a.fs.write("x.bin", new Uint8Array(10));
  const res = await a.fs.stat("x.bin");
  assert.equal(res.size, 10);
  const missing = await a.fs.stat("nothing.bin");
  assert.equal(missing.found, false);
});

test("round 2 #3a: an upload already running when sharing starts isn't lost", async () => {
  const d = device();
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  let writing = false;
  d.files.faults.delay = (root, path) => (root === "data" && path.includes("/files/") ? ((writing = true), 400) : 0);
  const data = new Uint8Array(30_000).map((_, i) => (i * 7) & 255);
  const uploading = view.client.upload(ws.id, new Blob([data]), "photo.png");
  await until(() => writing, 3000, "the upload is writing its file");
  const sharing = d.notes.call("shareWorkspace", { workspace: ws.id });
  const ref = await uploading;
  assert.equal((await sharing).ok, true);
  d.files.faults.delay = undefined;
  const back = await view.client.call("file", { workspace: ws.id, ref });
  assert.equal(Buffer.from(back.data, "base64").length, data.length);
});

test("round 2 #3b: a failed save while sharing leaves the workspace open and private", async () => {
  let fail = false;
  const d = device({ failSave: (k) => fail && k === "workspaces" });
  const [ws] = await booted(d);
  fail = true;
  await assert.rejects(d.notes.call("shareWorkspace", { workspace: ws.id }));
  fail = false;
  const info = d.notes.workspaces()[0];
  assert.equal(info.shared, false);
  assert.equal(info.state, "ready");
  assert.ok(d.notes.treeOf(ws.id), "still open");
  const { page } = await d.notes.call("createPage", { workspace: ws.id, parent: "", kind: "page", title: "After" });
  assert.equal(model.getPage(d.notes.treeOf(ws.id), page).title, "After");
});

test("round 2 #6a: the document cap counts every device's files together", async () => {
  const dir = tempDir();
  const cap = 64 * 1024;
  for (const id of ["deva", "devb"]) {
    const own = tempDir();
    const w = store(own, id, { compactAt: 1 });
    await w.store.open();
    const doc = await w.store.get(PAGE);
    doc.getText(id).insert(0, "x".repeat(Math.floor(cap * 0.75)));
    await w.store.whenIdle();
    await w.store.close();
    mkdirSync(join(dir, "ws1/docs", PAGE), { recursive: true });
    cpSync(join(own, "ws1/docs", PAGE), join(dir, "ws1/docs", PAGE), { recursive: true });
  }
  const r = store(dir, "devr", { extra: { maxDocBytes: cap } });
  await r.store.open();
  await r.store.get(PAGE);
  assert.ok(r.store.rejected().includes(PAGE), "two snapshots of 3/4 cap each are over the cap");
});

test("round 2 #6b: a small workspace compacting again and again stays under its budget", async () => {
  const dir = tempDir();
  const a = store(dir, "deva", { compactAt: 1 });
  const b = store(dir, "devb", { extra: { maxWorkspaceBytes: 64 * 1024 } });
  await Promise.all([a.store.open(), b.store.open()]);
  const doc = await a.store.get(PAGE);
  doc.getText("t").insert(0, "y".repeat(8000));
  await a.store.whenIdle();
  const seen = await b.store.get(PAGE);
  for (let i = 0; i < 30; i++) {
    doc.getMap("m").set("i", i);
    await a.store.whenIdle();
    await b.store.rescan();
  }
  await until(() => seen.getMap("m").get("i") === 29, 3000, "the last edit");
  assert.deepEqual(b.store.rejected(), []);
});

test("round 2 #7: a finishing upload keeps its quota until it is written", async () => {
  const d = device({ uploadLimits: { bytes: 150_000 } });
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  let writing = false;
  d.files.faults.delay = (root, path) => (path.includes("/files/") ? ((writing = true), 500) : 0);
  const a = new Uint8Array(90_000).fill(1);
  const first = view.client.upload(ws.id, new Blob([a]), "a.bin");
  await until(() => writing, 3000, "the first upload is writing its file");
  await assert.rejects(view.client.upload(ws.id, new Blob([new Uint8Array(90_000).fill(2)]), "b.bin"), /too much/);
  await first;
  d.files.faults.delay = undefined;
  await view.client.upload(ws.id, new Blob([new Uint8Array(90_000).fill(3)]), "c.bin");
});

test("round 2 #8: an edit the page couldn't send before it closed reaches main on the next load", async () => {
  const d = device({ hub: { pageBucket: { burst: 3, perSecond: 1 } } });
  const [ws] = await booted(d);
  const storage = new Map();
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0].id;
  const one = d.open("v1", { storage });
  await one.client.ready;
  const h = one.client.open(ws.id, `p:${page}`);
  await h.synced;
  await until(() => one.sent.some((m) => m.t === "aw"), 3000, "the page's cursor went out");
  for (let i = 0; i < 8; i++) h.doc.getMap("late").set(`k${i}`, i);
  one.close();
  const two = d.open("v2", { storage });
  await two.client.ready;
  const again = two.client.open(ws.id, `p:${page}`);
  await again.synced;
  const mainDoc = await d.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("late").size === 8, 15_000, "the unsent edits");
  again.release();
});

test("round 2 cursors: an expired cursor isn't revived by an unchanged file", async () => {
  const dir = tempDir();
  const files = M.nodeFiles({ data: dir });
  const fs = M.ardiaFileStore(files, "data", "");
  const update = (clock) => Buffer.from(M.encodeAwareness([{ id: 7, clock, state: JSON.stringify({ user: { name: "A" } }) }])).toString("base64");
  await fs.writeText("presence/deva.aw", JSON.stringify({ at: 1, docs: { "p:aaaaaaaaaaaa": update(1) } }));
  const delivered = [];
  let now = Date.now();
  const reader = new M.CursorSync({ fs, deviceId: "devb", timers: { setTimeout, clearTimeout, now: () => now }, staleMs: 1000, collect: () => new Map(), deliver: (doc, u) => delivered.push(M.awarenessClients(u).map((c) => (c.removed ? "gone" : "here"))) });
  cleanups.push(() => reader.close());
  const mtime = async () => (await fs.list("presence")).find((e) => e.path.endsWith("deva.aw")).mtimeMs;
  reader.remoteChanged("deva", await mtime());
  await until(() => delivered.length === 1, 2000, "cursor delivered");
  now += 2000;
  reader.sweep();
  assert.deepEqual(delivered, [["here"], ["gone"]]);
  reader.remoteChanged("deva", await mtime());
  reader.remoteChanged("deva", null);
  await reader.settled();
  assert.deepEqual(delivered, [["here"], ["gone"]], "an unchanged file doesn't bring it back");
  await fs.writeText("presence/deva.aw", JSON.stringify({ at: 2, docs: { "p:aaaaaaaaaaaa": update(2) } }));
  reader.remoteChanged("deva", await mtime());
  await until(() => delivered.length === 3, 2000, "a changed file revives it");
});

test("round 2 durable acks: an edit is acked only once it is on disk, and survives a crash before the flush", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  const storage = new Map();
  const pageStorage = new Map();
  const boot = (debounceMs) => {
    const files = M.nodeFiles({ data: join(dir, "data") });
    const hub = M.pageHub();
    const notes = new M.Notes({
      files,
      folders: null,
      storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
      setting: () => undefined,
      post: hub.post,
      openPage: async () => {},
      openUrl: async () => {},
      store: { debounceMs, rescanMs: 0 },
      log: () => {},
    });
    hub.attach(notes);
    return { files, hub, notes };
  };
  const first = boot(60_000);
  await first.notes.start();
  await until(() => first.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  const [ws] = first.notes.workspaces();
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  await first.notes.spaceStore(ws.id).flush();
  const view = first.hub.open("v1", { storage: pageStorage });
  await view.client.ready;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  h.doc.getMap("crash").set("kept", true);
  const mainDoc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("crash").get("kept") === true, 3000, "main applied the edit");
  await first.notes.whenViewsIdle();
  await view.client.call("search", { query: "anything" });
  assert.ok(!view.received.some((m) => m.t === "ack"), "no ack before the append");
  assert.ok([...pageStorage.keys()].some((k) => k.includes(page)), "the page still holds the edit");
  view.close();
  await first.notes.stop({ flush: false });
  first.files.detach();
  const second = boot(5);
  cleanups.push(async () => {
    await second.notes.stop();
    second.files.detach();
  });
  await second.notes.start();
  await until(() => second.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready again");
  const before = await second.notes.spaceStore(ws.id).get(`p-${page}`);
  assert.equal(before.getMap("crash").get("kept"), undefined, "the crash lost it on disk");
  const again = second.hub.open("v2", { storage: pageStorage });
  cleanups.push(() => again.close());
  await again.client.ready;
  const h2 = again.client.open(ws.id, `p:${page}`);
  await h2.synced;
  await until(() => again.received.some((m) => m.t === "ack"), 5000, "acked after the append");
  await until(() => ![...pageStorage.keys()].some((k) => k.includes(page)), 3000, "the page lets go once acked");
  const check = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: join(dir, "data") }), "data", `workspaces/${ws.id}`), deviceId: "checker", rescanMs: 0 });
  await check.open();
  assert.equal((await check.get(`p-${page}`)).getMap("crash").get("kept"), true, "on disk");
  await check.close();
  h2.release();
});

test("a device that quits without clearing its cursor file loses its cursors within 30 s", () => {
  assert.ok(M.CURSOR_KEEPALIVE + M.CURSOR_STALE + M.CURSOR_SWEEP(M.CURSOR_STALE) <= 30_000);
  assert.ok(M.CURSOR_KEEPALIVE * 2 < M.CURSOR_STALE, "a missed keepalive doesn't drop a live device");
});
