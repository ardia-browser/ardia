import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until, rng } from "./support/build.mjs";

const M = await load();
const { Y, model } = M;
const PAGE = "p-aaaaaaaaaaaa";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const tempDir = () => mkdtempSync(join(tmpdir(), "notes-review-"));

function store(dir, id, options = {}) {
  const files = options.files ?? M.nodeFiles({ data: dir });
  const fs = M.ardiaFileStore(files, "data", "ws1", { callMax: options.callMax });
  const errors = [];
  const s = new M.WorkspaceStore({ fs, deviceId: id, debounceMs: 2, rescanMs: 0, compactAt: options.compactAt ?? 256 * 1024, onError: (e, w) => errors.push(`${w}: ${e?.message ?? e}`), ...(options.extra ?? {}) });
  cleanups.push(() => s.close().catch(() => undefined));
  return { files, fs, store: s, errors };
}

const words = (seed, n) => {
  const random = rng(seed);
  return Array.from({ length: n }, () => Math.floor(random() * 1e9).toString(36)).join(" ");
};

test("review 1: a snapshot over the call limit that fails halfway leaves the last good snapshot readable", async () => {
  const dir = tempDir();
  const a = store(dir, "deva", { callMax: 4096, compactAt: 1 });
  await a.store.open();
  const doc = await a.store.get(PAGE);
  doc.getText("t").insert(0, words(1, 2000));
  await a.store.whenIdle();
  const before = doc.getText("t").toString();
  let failing = true;
  a.files.faults.append = (_root, path) => (failing && path.endsWith(".snap") ? -1 : null);
  a.files.faults.write = (_root, path) => failing && /\.chunks/.test(path);
  doc.getText("t").insert(0, "more ");
  await a.store.whenIdle();
  const b = store(dir, "devb");
  await b.store.open();
  const seen = (await b.store.get(PAGE)).getText("t").toString();
  assert.ok(seen.endsWith(before), "the old content is still there");
  assert.ok(seen.startsWith("more "), "the newer edit survives in the log");
  failing = false;
  doc.getText("t").insert(0, "again ");
  await a.store.whenIdle();
  const c = store(dir, "devc");
  await c.store.open();
  assert.equal((await c.store.get(PAGE)).getText("t").toString(), doc.getText("t").toString());
});

test("review 2: a torn append is never followed by a blind retry that breaks framing", async () => {
  const dir = tempDir();
  const a = store(dir, "deva");
  await a.store.open();
  const doc = await a.store.get(PAGE);
  doc.getMap("m").set("one", 1);
  await a.store.whenIdle();
  let tear = true;
  a.files.faults.append = (_root, path, size) => (tear && path.endsWith(".log") ? ((tear = false), Math.floor(size / 2)) : null);
  doc.getMap("m").set("two", 2);
  await a.store.flush();
  await until(async () => {
    await a.store.whenIdle();
    return !a.store.hasPending();
  }, 5000, "the store recovers");
  doc.getMap("m").set("three", 3);
  await a.store.whenIdle();
  const b = store(dir, "devb");
  await b.store.open();
  const m = (await b.store.get(PAGE)).getMap("m");
  assert.deepEqual([m.get("one"), m.get("two"), m.get("three")], [1, 2, 3]);
});

test("review 2b: a reader resynchronises past a torn record in someone else's log", async () => {
  const dir = tempDir();
  const a = store(dir, "deva");
  await a.store.open();
  const doc = await a.store.get(PAGE);
  doc.getMap("m").set("one", 1);
  await a.store.whenIdle();
  const log = join(dir, "ws1/docs", PAGE, "deva.log");
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const sv = Y.encodeStateVector(scratch);
  scratch.getMap("m").set("lost", true);
  const torn = M.encodeRecord(Y.encodeStateAsUpdate(scratch, sv));
  appendFileSync(log, torn.subarray(0, torn.length - 3));
  const sv2 = Y.encodeStateVector(scratch);
  scratch.getMap("m").set("after", true);
  appendFileSync(log, M.encodeRecord(Y.encodeStateAsUpdate(scratch, sv2)));
  const b = store(dir, "devb");
  await b.store.open();
  const m = (await b.store.get(PAGE)).getMap("m");
  assert.equal(m.get("one"), 1);
  assert.equal(m.get("after"), undefined, "an update that depends on the torn one waits for it");
  assert.ok(b.errors.some((e) => /damaged/.test(e)), "the damaged record is reported");
  const healthy = new Y.Doc();
  healthy.getMap("m").set("independent", true);
  appendFileSync(log, M.encodeRecord(Y.encodeStateAsUpdate(healthy)));
  b.files.emit("data", [`ws1/docs/${PAGE}/deva.log`]);
  await until(() => m.get("independent") === true, 3000, "a record after the torn one still applies");
});

function device(options = {}) {
  const dir = options.dir ?? tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  const sharedRoot = join(dir, "shared");
  mkdirSync(sharedRoot, { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") }, { latencyMs: options.latencyMs });
  const folders = M.fakeFolders(files, sharedRoot);
  const storage = new Map();
  const hub = M.pageHub(options.hub);
  const host = {
    files,
    folders,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => undefined,
    post: hub.post,
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 5, rescanMs: 200 },
    log: () => {},
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  const pages = [];
  const d = {
    dir,
    files,
    folders,
    notes,
    hub,
    open(view) {
      const p = hub.open(view);
      pages.push(p);
      return p;
    },
  };
  cleanups.push(async () => {
    for (const p of pages) p.close();
    await notes.stop();
    files.detach();
  });
  return d;
}

async function booted(d) {
  await d.notes.start();
  await until(() => d.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  await d.notes.whenIdle();
  return d.notes.workspaces();
}

test("review 3a: sharing stops and keeps the private copy when an attachment doesn't copy", async () => {
  const d = device();
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const data = new Uint8Array(20_000).map((_, i) => (i * 13) & 255);
  const ref = await view.client.upload(ws.id, new Blob([data]), "a.png");
  d.files.faults.write = (root, path) => root !== "data" && path.startsWith("files/");
  await assert.rejects(d.notes.call("shareWorkspace", { workspace: ws.id }));
  d.files.faults.write = undefined;
  const info = d.notes.workspaces()[0];
  assert.equal(info.shared, false);
  const back = await view.client.call("file", { workspace: ws.id, ref });
  assert.equal(Buffer.from(back.data, "base64").length, data.length);
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0];
  assert.equal(page.title, "Getting Started");
});

test("review 3b: edits made while a workspace is being shared reach the shared copy", async () => {
  const d = device({ latencyMs: 15 });
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0].id;
  const h = view.client.open(ws.id, `p:${page}`);
  await h.synced;
  const sharing = d.notes.call("shareWorkspace", { workspace: ws.id });
  for (let i = 0; i < 30; i++) {
    h.doc.getMap("live").set(`k${i}`, i);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal((await sharing).ok, true);
  await until(async () => {
    await d.notes.whenIdle();
    const doc = await d.notes.spaceStore(ws.id).get(`p-${page}`);
    return doc.getMap("live").size === 30;
  }, 5000, "every edit in the shared copy");
  const dir = d.files.roots.get(d.notes.workspaces()[0].folderId);
  const fresh = M.nodeFiles({ data: dir });
  const reader = new M.WorkspaceStore({ fs: M.ardiaFileStore(fresh, "data", ""), deviceId: "reader", rescanMs: 0 });
  await reader.open();
  assert.equal((await reader.get(`p-${page}`)).getMap("live").size, 30, "the folder on disk has them too");
  await reader.close();
  h.release();
});

test("review 6: a hostile collaborator's huge files are refused without reading them whole", async () => {
  const dir = tempDir();
  const files = M.nodeFiles({ data: dir });
  const b = store(dir, "devb", { files, extra: { maxDocBytes: 256 * 1024, maxDevices: 8 } });
  const docs = join(dir, "ws1/docs");
  mkdirSync(join(docs, PAGE), { recursive: true });
  writeFileSync(join(docs, PAGE, "evil.log"), Buffer.alloc(3 * 1024 * 1024, 7));
  writeFileSync(join(docs, PAGE, "evil.snap"), Buffer.alloc(3 * 1024 * 1024, 9));
  mkdirSync(join(docs, "p-bbbbbbbbbbbb"), { recursive: true });
  const good = new Y.Doc();
  good.getMap("m").set("fine", true);
  writeFileSync(join(docs, "p-bbbbbbbbbbbb", "friend.log"), M.encodeRecord(Y.encodeStateAsUpdate(good)));
  mkdirSync(join(dir, "ws1/presence"), { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, "ws1/presence", `d${i}.json`), JSON.stringify({ name: "x".repeat(5000), color: "#fff", page: "aaaaaaaaaaaa", at: Date.now() }));
  writeFileSync(join(dir, "ws1/presence", "evil.aw"), "x".repeat(2 * 1024 * 1024));
  await b.store.open();
  await b.store.loadAll();
  assert.equal((await b.store.get("p-bbbbbbbbbbbb")).getMap("m").get("fine"), true);
  assert.ok(files.bytesRead < 1024 * 1024, `read ${files.bytesRead} bytes`);
  assert.ok(b.store.rejected().includes(PAGE));
  assert.ok(b.store.presence().length <= 8);
  assert.equal(b.store.state, "ready");
});

test("review 7: ops are validated, inherited names aren't ops, and uploads belong to their view", async () => {
  const d = device();
  const [ws] = await booted(d);
  const one = d.open("v1");
  const two = d.open("v2");
  await Promise.all([one.client.ready, two.client.ready]);
  await assert.rejects(one.client.call("constructor", {}), /can't/);
  await assert.rejects(one.client.call("hasOwnProperty", {}), /can't/);
  await assert.rejects(one.client.call("createPage", { workspace: ws.id, parent: "", kind: "page", title: 42 }), /title/);
  await assert.rejects(one.client.call("createPage", { workspace: ws.id, parent: "", kind: "spaceship" }), /kind/);
  await assert.rejects(one.client.call("search", { query: { $gt: "" } }), /query/);
  await assert.rejects(one.client.call("movePage", { workspace: ws.id, page: "nope", parent: "" }), /page/);
  const send = (view, msg) => view.client.call(msg.op, msg.args);
  await send(one, { op: "uploadPart", args: { uploadId: "shared", i: 0, data: Buffer.from("hello").toString("base64") } });
  await assert.rejects(send(two, { op: "upload", args: { workspace: ws.id, name: "x.txt", type: "text/plain", uploadId: "shared" } }), /didn't arrive/);
  const big = "A".repeat(40_000);
  for (let i = 0; i < 2000; i++) {
    try {
      await send(one, { op: "uploadPart", args: { uploadId: "grow", i: 0, data: big.slice(0, 4 * (i + 1)) } });
    } catch {
      break;
    }
  }
  await assert.rejects(
    (async () => {
      for (let i = 0; i < 4000; i++) await send(one, { op: "uploadPart", args: { uploadId: `many${i}`, i: 0, data: big } });
    })(),
    /too much/,
  );
});

test("review 8: a 5 MB upload stays under the page's message limit and finishes", async () => {
  const d = device({ hub: { nativeLimit: true } });
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const data = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 31) & 255);
  const ref = await view.client.upload(ws.id, new Blob([data]), "big.bin");
  assert.match(ref, /^file:/);
  assert.equal(view.dropped(), 0, "nothing was dropped by the page's limit");
});

test("review 11: two versions in the same millisecond both survive", async () => {
  const dir = tempDir();
  const files = M.nodeFiles({ data: dir });
  const fs = M.ardiaFileStore(files, "data", "history");
  const history = new M.History(fs, "dev", { now: () => 1_700_000_000_000, setTimeout, clearTimeout });
  const a = new Y.Doc();
  a.getText("t").insert(0, "first");
  await history.snapshot("w", "aaaaaaaaaaaa", a);
  a.getText("t").insert(0, "second ");
  await history.snapshot("w", "aaaaaaaaaaaa", a);
  const list = await history.list("w", "aaaaaaaaaaaa");
  assert.equal(list.length, 2);
  const states = await Promise.all(list.map((v) => history.state("w", "aaaaaaaaaaaa", v.id)));
  const texts = states.map((s) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, s);
    return d.getText("t").toString();
  });
  assert.deepEqual(texts.sort(), ["first", "second first"]);
  assert.equal(readdirSync(join(dir, "history/w/aaaaaaaaaaaa")).length, 2);
});
