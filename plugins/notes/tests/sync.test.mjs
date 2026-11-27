import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, rng, until } from "./support/build.mjs";

const M = await load();
const { Y } = M;

const PAGE = "p-aaaaaaaaaaaa";
const PAGE2 = "p-bbbbbbbbbbbb";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "notes-sync-"));
}

function device(dir, id, options = {}) {
  const files = M.nodeFiles({ data: dir });
  const fs = M.ardiaFileStore(files, "data", "ws1");
  const errors = [];
  const store = new M.WorkspaceStore({
    fs,
    deviceId: id,
    debounceMs: options.debounceMs ?? 3,
    rescanMs: options.rescanMs ?? 0,
    compactAt: options.compactAt ?? 256 * 1024,
    onError: (error, where) => errors.push(`${where}: ${error?.message ?? error}`),
  });
  return { id, files, fs, store, errors };
}

const sortedMap = (map) => Object.fromEntries(Object.entries(map.toJSON()).sort(([a], [b]) => (a < b ? -1 : 1)));
const contentOf = (doc) => JSON.stringify({ m: sortedMap(doc.getMap("m")), t: doc.getText("t").toString(), a: doc.getArray("a").toJSON() });

async function settle(devices, names) {
  for (let round = 0; round < 4; round++) {
    for (const d of devices) await d.store.whenIdle();
    for (const d of devices) await d.store.rescan();
  }
  for (const d of devices) for (const name of names) await d.store.get(name);
}

async function assertConverged(devices, names) {
  await settle(devices, names);
  for (const name of names) {
    const states = await Promise.all(devices.map(async (d) => contentOf(await d.store.get(name))));
    for (let i = 1; i < states.length; i++) assert.equal(states[i], states[0], `${name} differs on ${devices[i].id}`);
    const vectors = await Promise.all(devices.map(async (d) => Buffer.from(Y.encodeStateVector(await d.store.get(name))).toString("hex")));
    for (let i = 1; i < vectors.length; i++) assert.equal(vectors[i], vectors[0], `${name} state vector differs on ${devices[i].id}`);
  }
}

test("one device: what it writes comes back after a restart", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  await a.store.open();
  const tree = await a.store.get("ws");
  tree.getMap("m").set("hello", "world");
  const page = a.store.create(PAGE);
  page.getText("t").insert(0, "some text");
  await a.store.close();
  const again = device(dir, "deva");
  await again.store.open();
  assert.equal((await again.store.get("ws")).getMap("m").get("hello"), "world");
  assert.equal((await again.store.get(PAGE)).getText("t").toString(), "some text");
  await again.store.close();
});

test("compaction writes a snapshot, empties the log and keeps everything", async () => {
  const dir = tempDir();
  const a = device(dir, "deva", { compactAt: 2000 });
  await a.store.open();
  const doc = await a.store.get(PAGE);
  for (let i = 0; i < 200; i++) {
    doc.getText("t").insert(0, `line ${i}\n`);
    if (i % 10 === 0) await a.store.flush();
  }
  await a.store.whenIdle();
  const log = join(dir, "ws1/docs", PAGE, "deva.log");
  const snap = join(dir, "ws1/docs", PAGE, "deva.snap");
  assert.ok(existsSync(snap), "snapshot written");
  assert.ok(statSync(log).size < 2000, "log was emptied");
  const want = doc.getText("t").toString();
  await a.store.close();
  const b = device(dir, "devb");
  await b.store.open();
  assert.equal((await b.store.get(PAGE)).getText("t").toString(), want);
  await b.store.close();
});

test("two devices with interleaved edits and concurrent compaction converge", async () => {
  const dir = tempDir();
  const a = device(dir, "deva", { compactAt: 200 });
  const b = device(dir, "devb", { compactAt: 200 });
  await Promise.all([a.store.open(), b.store.open()]);
  const random = rng(42);
  for (let i = 0; i < 120; i++) {
    const d = random() < 0.5 ? a : b;
    const doc = await d.store.get(random() < 0.5 ? PAGE : "ws");
    const r = random();
    if (r < 0.4) doc.getMap("m").set(`k${Math.floor(random() * 20)}`, `${d.id}-${i}`);
    else if (r < 0.8) doc.getText("t").insert(Math.floor(random() * (doc.getText("t").length + 1)), `${d.id[3]}${i} `);
    else doc.getArray("a").push([i]);
    if (i % 7 === 0) await new Promise((r) => setTimeout(r, 8));
  }
  await assertConverged([a, b], ["ws", PAGE]);
  const snapA = join(dir, "ws1/docs", PAGE, "deva.snap");
  const snapB = join(dir, "ws1/docs", PAGE, "devb.snap");
  assert.ok(existsSync(snapA) && existsSync(snapB), "both devices compacted");
  await Promise.all([a.store.close(), b.store.close()]);
});

test("a truncated log tail is skipped until the rest arrives", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  await a.store.open();
  const doc = await a.store.get(PAGE);
  doc.getMap("m").set("first", 1);
  await a.store.close();

  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(scratch);
  scratch.getMap("m").set("second", 2);
  const record = M.encodeRecord(Y.encodeStateAsUpdate(scratch, before));
  const log = join(dir, "ws1/docs", PAGE, "deva.log");
  const half = Math.floor(record.length / 2);
  appendFileSync(log, record.subarray(0, half));

  const b = device(dir, "devb");
  await b.store.open();
  const seen = await b.store.get(PAGE);
  assert.equal(seen.getMap("m").get("first"), 1);
  assert.equal(seen.getMap("m").get("second"), undefined);
  appendFileSync(log, record.subarray(half));
  b.files.emit("data", [`ws1/docs/${PAGE}/deva.log`]);
  await until(() => seen.getMap("m").get("second") === 2, 3000, "rest of the record");

  appendFileSync(log, new Uint8Array([0, 0, 1]));
  const restarted = device(dir, "deva");
  await restarted.store.open();
  const mine = await restarted.store.get(PAGE);
  await restarted.store.whenIdle();
  assert.ok(existsSync(join(dir, "ws1/docs", PAGE, "deva.snap")), "a device that finds its own torn tail compacts");
  assert.equal(statSync(log).size, M.LOG_HEADER.length, "the log holds only its header");
  mine.getMap("m").set("third", 3);
  await restarted.store.whenIdle();
  await until(() => seen.getMap("m").get("third") === 3, 3000, "an edit after the repair");
  await Promise.all([b.store.close(), restarted.store.close()]);
});

test("a damaged record doesn't stop the rest of the log", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  await a.store.open();
  const doc = await a.store.get(PAGE);
  doc.getMap("m").set("ok", true);
  await a.store.close();
  const log = join(dir, "ws1/docs", PAGE, "deva.log");
  appendFileSync(log, M.encodeRecord(new Uint8Array([200, 1, 2, 3, 4, 5])));
  const b = device(dir, "devb");
  await b.store.open();
  assert.equal((await b.store.get(PAGE)).getMap("m").get("ok"), true);
  assert.ok(b.errors.some((e) => /didn't apply/.test(e)));
  await b.store.close();
});

test("iCloud placeholders are waited for, then read", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  await a.store.open();
  (await a.store.get(PAGE)).getText("t").insert(0, "from the cloud");
  await a.store.close();
  const b = device(dir, "devb");
  b.files.hide("data", `ws1/docs/${PAGE}/deva.log`);
  await b.store.open();
  const doc = await b.store.get(PAGE);
  assert.equal(doc.getText("t").toString(), "");
  assert.equal(b.store.waiting, 1);
  assert.equal(b.store.state, "downloading");
  b.files.reveal("data", `ws1/docs/${PAGE}/deva.log`);
  await until(() => doc.getText("t").toString() === "from the cloud", 3000, "placeholder download");
  await b.store.rescan();
  assert.equal(b.store.waiting, 0);
  assert.equal(b.store.state, "ready");
  await b.store.close();
});

test("a device that joins late gets everything, and new docs appear mid-session", async () => {
  const dir = tempDir();
  const a = device(dir, "deva", { compactAt: 500 });
  const b = device(dir, "devb", { compactAt: 500 });
  await Promise.all([a.store.open(), b.store.open()]);
  for (let i = 0; i < 60; i++) {
    const d = i % 2 ? a : b;
    (await d.store.get(PAGE)).getText("t").insert(0, `${i},`);
  }
  const added = [];
  const c = device(dir, "devc");
  c.store = new M.WorkspaceStore({ fs: c.fs, deviceId: "devc", debounceMs: 3, rescanMs: 0, onDocAdded: (name) => added.push(name) });
  await settle([a, b], ["ws", PAGE]);
  await c.store.open();
  await c.store.loadAll();
  a.store.create(PAGE2).getMap("m").set("new", "doc");
  await a.store.whenIdle();
  await until(() => added.includes(PAGE2), 3000, "new doc noticed");
  await assertConverged([a, b, c], ["ws", PAGE, PAGE2]);
  await Promise.all([a.store.close(), b.store.close(), c.store.close()]);
});

test("a folder that is gone shows as missing", async () => {
  const dir = tempDir();
  const files = M.nodeFiles({ data: join(dir, "gone") });
  const fs = M.ardiaFileStore(files, "data", "");
  const store = new M.WorkspaceStore({ fs, deviceId: "deva", debounceMs: 3, rescanMs: 0 });
  await store.open();
  assert.equal(store.state, "missing");
  await store.close();
});

test("three devices with random edits, restarts and compaction converge (seeded fuzz)", async () => {
  for (const seed of [1, 2, 3]) {
    const dir = tempDir();
    const random = rng(seed * 7919);
    const ids = ["dev1", "dev2", "dev3"];
    const devices = ids.map((id) => device(dir, id, { compactAt: 300 + Math.floor(random() * 900) }));
    await Promise.all(devices.map((d) => d.store.open()));
    const names = ["ws", PAGE, PAGE2];
    for (let i = 0; i < 250; i++) {
      const k = Math.floor(random() * devices.length);
      const d = devices[k];
      const r = random();
      if (r < 0.03) {
        await d.store.close();
        devices[k] = device(dir, d.id, { compactAt: 300 + Math.floor(random() * 900) });
        await devices[k].store.open();
        continue;
      }
      const doc = await d.store.get(names[Math.floor(random() * names.length)]);
      if (r < 0.35) doc.getMap("m").set(`k${Math.floor(random() * 12)}`, i);
      else if (r < 0.6) doc.getText("t").insert(Math.floor(random() * (doc.getText("t").length + 1)), String.fromCharCode(97 + (i % 26)));
      else if (r < 0.75 && doc.getText("t").length > 0) {
        const at = Math.floor(random() * doc.getText("t").length);
        doc.getText("t").delete(at, Math.min(3, doc.getText("t").length - at));
      } else if (r < 0.9) doc.getArray("a").push([`${d.id}:${i}`]);
      else if (r < 0.95) await d.store.flush();
      else await new Promise((res) => setTimeout(res, Math.floor(random() * 10)));
    }
    await assertConverged(devices, names);
    await Promise.all(devices.map((d) => d.store.close()));
    const late = device(dir, "dev9");
    await late.store.open();
    await late.store.loadAll();
    const reference = device(dir, "dev1");
    await reference.store.open();
    for (const name of names) assert.equal(contentOf(await late.store.get(name)), contentOf(await reference.store.get(name)), `seed ${seed} ${name}`);
    await Promise.all([late.store.close(), reference.store.close()]);
  }
});

test("content-addressed files are written once and verified on read", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  await a.store.open();
  const data = new Uint8Array(5000).map((_, i) => i & 255);
  const sha = await a.store.putFile(data, "png");
  assert.equal(await a.store.putFile(data, "png"), sha);
  const b = device(dir, "devb");
  await b.store.open();
  const got = await b.store.getFile(sha);
  assert.deepEqual([...got.data], [...data]);
  assert.match(got.name, /\.png$/);
  const path = join(dir, "ws1/files", got.name);
  assert.ok(readFileSync(path).length === 5000);
  assert.equal(await b.store.getFile("0".repeat(64)), null);
  await Promise.all([a.store.close(), b.store.close()]);
});

test("presence files show who has a page open", async () => {
  const dir = tempDir();
  const a = device(dir, "deva");
  const b = device(dir, "devb");
  await Promise.all([a.store.open(), b.store.open()]);
  a.store.setPresence({ name: "Ada", color: "#e03e3e", page: "aaaaaaaaaaaa" });
  await until(() => b.store.presence().length === 1, 3000, "presence");
  assert.equal(b.store.presence()[0].name, "Ada");
  a.store.setPresence(null);
  await until(() => b.store.presence().length === 0, 3000, "presence gone");
  await Promise.all([a.store.close(), b.store.close()]);
});
