import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
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

const tempDir = () => mkdtempSync(join(tmpdir(), "notes-review3-"));

function world(options = {}) {
  const dir = options.dir ?? tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  const storage = options.storage ?? new Map();
  const pageStorage = options.pageStorage ?? new Map();
  const boot = (bootOptions = {}) => {
    const files = M.nodeFiles({ data: join(dir, "data") });
    const folders = M.fakeFolders(files, join(dir, "shared"));
    const hub = M.pageHub(bootOptions.hub);
    const notes = new M.Notes({
      files,
      folders,
      storage: {
        get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined),
        set: async (k, v) => {
          if (bootOptions.beforeSave) await bootOptions.beforeSave(k, v);
          storage.set(k, structuredClone(v));
        },
      },
      setting: () => undefined,
      post: hub.post,
      openPage: async () => {},
      openUrl: async () => {},
      store: { debounceMs: bootOptions.debounceMs ?? 5, rescanMs: 0 },
      uploadLimits: bootOptions.uploadLimits,
      log: () => {},
    });
    hub.attach(notes);
    const pages = [];
    const instance = {
      files,
      folders,
      hub,
      notes,
      open(view, openOptions = {}) {
        const p = hub.open(view, { storage: pageStorage, ...openOptions });
        pages.push(p);
        return p;
      },
      async crash() {
        for (const p of pages) p.close();
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

async function onDisk(dir, ws, page) {
  const check = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: join(dir, "data") }), "data", `workspaces/${ws}`), deviceId: "checker", rescanMs: 0 });
  await check.open();
  const doc = await check.get(`p-${page}`);
  const json = doc.getMap("edits").toJSON();
  await check.close();
  return json;
}

const journalKeys = (map) => [...map.keys()].filter((k) => k.startsWith("ardia-notes-journal|"));

test("H1a: a reload that already sees the edit still keeps it until main has it on disk", async () => {
  const w = world();
  const first = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  await first.notes.spaceStore(ws.id).flush();
  const one = first.open("v1");
  await one.client.ready;
  const a = one.client.open(ws.id, `p:${page}`);
  await a.synced;
  a.doc.getMap("edits").set("one", true);
  const mainDoc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("edits").get("one") === true, 3000, "applied");
  one.vanish();
  const two = first.open("v2");
  await two.client.ready;
  const b = two.client.open(ws.id, `p:${page}`);
  await b.synced;
  assert.equal(b.doc.getMap("edits").get("one"), true);
  await first.notes.whenViewsIdle();
  assert.ok(journalKeys(w.pageStorage).length > 0, "the journal still holds the edit");
  await first.crash();
  const second = w.boot();
  await ready(second);
  const three = second.open("v3");
  await three.client.ready;
  await until(async () => (await onDisk(w.dir, ws.id, page)).one === true, 5000, "the edit on disk after the crash");
  await until(() => journalKeys(w.pageStorage).length === 0, 3000, "journal cleared by acks");
});

test("H1b: two views of one doc keep their own unsent edits", async () => {
  const w = world();
  const first = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  await first.notes.spaceStore(ws.id).flush();
  const one = first.open("v1");
  const two = first.open("v2");
  await Promise.all([one.client.ready, two.client.ready]);
  const a = one.client.open(ws.id, `p:${page}`);
  const b = two.client.open(ws.id, `p:${page}`);
  await Promise.all([a.synced, b.synced]);
  a.doc.getMap("edits").set("fromA", true);
  b.doc.getMap("edits").set("fromB", true);
  const mainDoc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("edits").get("fromA") && mainDoc.getMap("edits").get("fromB"), 3000, "both applied");
  await first.crash();
  const second = w.boot();
  await ready(second);
  const three = second.open("v3");
  await three.client.ready;
  await until(async () => {
    const edits = await onDisk(w.dir, ws.id, page);
    return edits.fromA === true && edits.fromB === true;
  }, 5000, "both edits on disk");
});

test("H2: an update waiting on a missing dependency isn't acked until it is integrated and written", async () => {
  const w = world();
  const first = w.boot();
  const [ws] = await ready(first);
  const page = model.childrenOf(first.notes.treeOf(ws.id), "")[0].id;
  const view = first.open("v1");
  await view.client.ready;
  const source = new Y.Doc();
  source.clientID = 424242;
  source.getMap("edits").set("first", 1);
  const firstUpdate = Y.encodeStateAsUpdate(source);
  const sv = Y.encodeStateVector(source);
  source.getMap("edits").set("second", 2);
  const secondUpdate = Y.encodeStateAsUpdate(source, sv);
  const b64 = (u) => Buffer.from(u).toString("base64");
  const acked = () => view.received.filter((m) => m.t === "ack" && m.seq >= 9001).map((m) => m.seq);
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(secondUpdate), seq: 9002 });
  await until(async () => {
    await first.notes.whenIdle();
    return view.sent.some((m) => m.seq === 9002);
  }, 3000, "sent");
  await first.notes.whenIdle();
  await view.client.call("search", { query: "x" });
  assert.deepEqual(acked(), [], "no ack while it waits on its dependency");
  view.ardia.send({ t: "up", doc: `p:${page}`, workspace: ws.id, u: b64(firstUpdate), seq: 9001 });
  await until(() => acked().includes(9001) && acked().includes(9002), 3000, "both acked once integrated");
  const doc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  assert.equal(doc.getMap("edits").get("second"), 2);
});

test("H3: two shares of one workspace at once share it once and lose nothing", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const view = inst.open("v1");
  await view.client.ready;
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  const [x, y] = await Promise.all([inst.notes.call("shareWorkspace", { workspace: ws.id }), inst.notes.call("shareWorkspace", { workspace: ws.id }), (async () => {
    for (let i = 0; i < 20; i++) {
      h.doc.getMap("edits").set(`k${i}`, i);
      await until(() => true);
    }
  })()]);
  assert.equal(x.ok && y.ok, true);
  const folders = readdirSync(join(w.dir, "shared"));
  assert.equal(folders.length, 1, "one shared folder");
  await until(async () => {
    await inst.notes.whenIdle();
    const doc = await inst.notes.spaceStore(ws.id).get(`p-${page}`);
    return doc.getMap("edits").size === 20;
  }, 5000, "every edit survives");
  h.release();
});

test("H4: records saved during a failed share never keep the abandoned grant", async () => {
  const w = world();
  let failNext = false;
  let created = null;
  let inst;
  inst = w.boot({
    beforeSave: async (k, v) => {
      if (k !== "workspaces" || !failNext || !v.some((r) => r.shared)) return;
      failNext = false;
      created = inst.notes.call("createWorkspace", { name: "Side" });
      await until(() => inst.notes.workspaces().some((r) => r.name === "Side"), 3000, "the other workspace exists");
      throw new Error("disk full");
    },
  });
  const [ws] = await ready(inst);
  failNext = true;
  await assert.rejects(inst.notes.call("shareWorkspace", { workspace: ws.id }));
  await created;
  await inst.notes.whenIdle();
  const saved = w.storage.get("workspaces");
  assert.ok(saved.some((r) => r.name === "Side"));
  assert.ok(!saved.some((r) => r.shared), JSON.stringify(saved));
});

test("H5a: our own big snapshot is never refused at reopen", async () => {
  const dir = tempDir();
  const open = async () => {
    const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1", { callMax: 8192 }), deviceId: "mine", debounceMs: 2, rescanMs: 0, compactAt: 1, maxDocBytes: 16 * 1024 });
    cleanups.push(() => s.close().catch(() => undefined));
    await s.open();
    return s;
  };
  const a = await open();
  (await a.get(PAGE)).getText("t").insert(0, "z".repeat(40_000));
  await a.whenIdle();
  await a.close();
  const b = await open();
  assert.equal((await b.get(PAGE)).getText("t").length, 40_000);
  assert.deepEqual(b.rejected(), []);
});

test("H5b: a remote device's deleted files stop counting against the cap", async () => {
  const dir = tempDir();
  const cap = 64 * 1024;
  const write = async (id, text) => {
    const own = tempDir();
    const s = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: own }), "data", "ws1"), deviceId: id, debounceMs: 2, rescanMs: 0, compactAt: 1 });
    await s.open();
    (await s.get(PAGE)).getText(id).insert(0, text);
    await s.whenIdle();
    await s.close();
    return join(own, "ws1/docs", PAGE);
  };
  const { cpSync } = await import("node:fs");
  const target = join(dir, "ws1/docs", PAGE);
  mkdirSync(target, { recursive: true });
  cpSync(await write("devbig", "b".repeat(50_000)), target, { recursive: true });
  const reader = new M.WorkspaceStore({ fs: M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "ws1"), deviceId: "reader", rescanMs: 0, maxDocBytes: cap });
  cleanups.push(() => reader.close().catch(() => undefined));
  await reader.open();
  await reader.get(PAGE);
  rmSync(join(target, "devbig.snap"));
  rmSync(join(target, "devbig.log"), { force: true });
  await reader.rescan();
  cpSync(await write("devnew", "n".repeat(30_000)), target, { recursive: true });
  await reader.rescan();
  assert.deepEqual(reader.rejected(), []);
  assert.equal((await reader.get(PAGE)).getText("devnew").length, 30_000);
});

test("M7: a finishing upload keeps its open slot until the write settles", async () => {
  const w = world();
  const inst = w.boot({ uploadLimits: { open: 1 } });
  const [ws] = await ready(inst);
  const view = inst.open("v1");
  await view.client.ready;
  let writing = false;
  inst.files.faults.delay = (root, path) => (path.includes("/files/") ? ((writing = true), 400) : 0);
  const first = view.client.upload(ws.id, new Blob([new Uint8Array(1000).fill(1)]), "a.bin");
  await until(() => writing, 3000, "the first upload is writing");
  await assert.rejects(view.client.upload(ws.id, new Blob([new Uint8Array(1000).fill(2)]), "b.bin"), /too much/);
  await first;
});

test("M8a: journaled edits from a reset device or for a deleted page aren't replayed into the notes", async () => {
  const w = world();
  const inst = w.boot();
  const [ws] = await ready(inst);
  const tree = inst.notes.treeOf(ws.id);
  const doomed = model.childrenOf(tree, "")[1].id;
  await inst.notes.call("deletePage", { workspace: ws.id, page: doomed });
  const deviceId = inst.notes.deviceId;
  const stray = new Y.Doc();
  stray.getMap("edits").set("ghost", true);
  const u = Buffer.from(Y.encodeStateAsUpdate(stray)).toString("base64");
  const now = Date.now();
  w.pageStorage.set(M.journalKey(deviceId, ws.id, `p:${doomed}`, "oldview", 1), JSON.stringify({ u, at: now }));
  w.pageStorage.set(M.journalKey("someotherdevice", ws.id, `p:${doomed}`, "oldview", 1), JSON.stringify({ u, at: now - 8 * 24 * 3600_000 }));
  const view = inst.open("v1");
  await view.client.ready;
  await until(() => journalKeys(w.pageStorage).length === 0, 3000, "both stray entries leave the journal");
  const doc = await inst.notes.spaceStore(ws.id).get(`p-${doomed}`);
  assert.equal(doc.getMap("edits").get("ghost"), undefined);
  assert.ok(view.client.saveState().refused >= 1);
});

test("M8b: a full journal keeps sending, says so, and clears abandoned entries first", async () => {
  const w = world();
  const inst = w.boot({ debounceMs: 60_000 });
  const [ws] = await ready(inst);
  const page = model.childrenOf(inst.notes.treeOf(ws.id), "")[0].id;
  const view = inst.open("v1", { quotaBytes: 2000 });
  await view.client.ready;
  const states = [];
  view.client.onSaveState((s) => states.push(s.state));
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  h.doc.getMap("edits").set("big", "q".repeat(5000));
  const mainDoc = await inst.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getMap("edits").get("big")?.length === 5000, 3000, "sent anyway");
  assert.ok(states.includes("unsaved"), states.join(","));
  await inst.notes.spaceStore(ws.id).flush();
  await until(() => view.client.saveState().state === "saved", 3000, "saved once acked");
  h.release();
});

test("M cursors: expired devices free their slots", async () => {
  const dir = tempDir();
  const fs = M.ardiaFileStore(M.nodeFiles({ data: dir }), "data", "");
  const update = (id) => Buffer.from(M.encodeAwareness([{ id, clock: 1, state: JSON.stringify({ user: { name: String(id) } }) }])).toString("base64");
  let now = Date.now();
  const delivered = [];
  const reader = new M.CursorSync({ fs, deviceId: "me", timers: { setTimeout, clearTimeout, now: () => now }, staleMs: 1000, maxRemotes: 2, collect: () => new Map(), deliver: (doc, u) => delivered.push(M.awarenessClients(u)[0].id) });
  cleanups.push(() => reader.close());
  for (const [device, id] of [["a", 1], ["b", 2]]) {
    await fs.writeText(`presence/${device}.aw`, JSON.stringify({ at: 1, docs: { "p:aaaaaaaaaaaa": update(id) } }));
    reader.remoteChanged(device, null);
  }
  await reader.settled();
  now += 5000;
  reader.sweep();
  await fs.writeText("presence/c.aw", JSON.stringify({ at: 1, docs: { "p:aaaaaaaaaaaa": update(3) } }));
  reader.remoteChanged("c", null);
  await reader.settled();
  assert.ok(delivered.includes(3), `delivered ${delivered}`);
});
