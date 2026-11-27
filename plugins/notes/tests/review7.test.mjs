import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { bundleFile, load, until } from "./support/build.mjs";

const M = await load();
const { Y, model, fflate } = M;
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const enc = (s) => new TextEncoder().encode(s);
const terminal = (j) => j && ["done", "failed", "cancelled"].includes(j.state);

function runInWorker(source, ms) {
  return new Promise((resolve) => {
    const worker = new Worker(`import(${JSON.stringify(`file://${bundleFile()}`)}).then(async (M) => { const { parentPort } = await import("node:worker_threads"); parentPort.postMessage(await (${source})(M)); });`, { eval: true });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ timedOut: true });
    }, ms);
    worker.once("message", (value) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error: String(error) });
    });
  });
}

test("4: two Macs moving pages under each other leaves both reachable, and deleting one finishes", async () => {
  const result = await runInWorker(
    `(M) => {
      const { Y, model } = M;
      const a = new Y.Doc();
      const A = model.createPage(a, { id: "aaaaaaaaaaaa", parent: "", kind: "page", title: "A", by: "x" });
      const B = model.createPage(a, { id: "bbbbbbbbbbbb", parent: "", kind: "page", title: "B", by: "x" });
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      model.movePage(a, A, B, undefined, "mac1");
      model.movePage(b, B, A, undefined, "mac2");
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      const top = model.childrenOf(a, "").map((p) => p.id);
      const underA = model.childrenOf(a, A).map((p) => p.id);
      const ancestors = model.ancestorsOf(a, B).map((p) => p.id);
      const doomed = model.deletePage(a, A, "x");
      return { top, underA, ancestors, doomed };
    }`,
    4000,
  );
  assert.ok(!result.timedOut, "deleting a page in a parent cycle finishes");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.top, ["aaaaaaaaaaaa"], "the cycle breaks at the lowest id, which becomes a top-level page");
  assert.deepEqual(result.underA, ["bbbbbbbbbbbb"]);
  assert.deepEqual(result.ancestors, ["aaaaaaaaaaaa"]);
  assert.deepEqual([...result.doomed].sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
});

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
function centralAt(zip) {
  for (let i = zip.length - 22; i >= 0; i--) if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) return zip[i + 16] | (zip[i + 17] << 8) | (zip[i + 18] << 16) | (zip[i + 19] << 24);
  throw new Error("no directory");
}
const bytesAccess = (bytes) => ({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)) });

test("8: a streamed zip entry inflates in bounded pieces and its CRC is checked", async () => {
  const size = 40 * 1024 * 1024;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 128) data[i] = (i * 7919) & 255;
  const zip = fflate.zipSync({ "big.bin": [data, { level: 9 }] });
  const reader = await M.ZipReader.open(bytesAccess(zip));
  assert.equal(reader.entries.length, 1);
  let biggest = 0;
  let total = 0;
  await reader.stream(reader.entries[0], async (chunk) => {
    biggest = Math.max(biggest, chunk.length);
    total += chunk.length;
  });
  assert.equal(total, size);
  assert.ok(biggest <= 16 * 1024 * 1024 + 64 * 1024, `no single piece is huge (${biggest})`);

  const small = fflate.zipSync({ "a.txt": [enc("hello hello hello hello"), { level: 6 }] });
  const dir = centralAt(small);
  small[dir + 16] ^= 0xff;
  const bad = await M.ZipReader.open(bytesAccess(small));
  await assert.rejects(
    bad.stream(bad.entries[0], async () => {}),
    /damaged/,
  );
});

test("8: archives inside an export can't spool more than the limit between them", async () => {
  const inner = (seed) => {
    const bytes = new Uint8Array(600);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * seed + 13) & 255;
    return fflate.zipSync({ "x.bin": [bytes, { level: 0 }] });
  };
  const outer = fflate.zipSync({ "a.zip": [inner(3), { level: 0 }], "b.zip": [inner(5), { level: 0 }] });
  const spool = {
    async create() {
      const parts = [];
      return {
        append: async (c) => void parts.push(c),
        done: async () => bytesAccess(Buffer.concat(parts)),
      };
    },
    async clear() {},
  };
  const base = { files: [{ path: "Export.zip", size: outer.length }], read: async () => outer };
  const was = M.IMPORT_LIMITS.spoolBytes;
  M.IMPORT_LIMITS.spoolBytes = 1000;
  try {
    await assert.rejects(M.LayeredVfs.build(base, () => bytesAccess(outer), spool), /too big/);
  } finally {
    M.IMPORT_LIMITS.spoolBytes = was;
  }
});

test("9: Notion asset paths with encoded dot segments or slashes are refused", () => {
  const origin = "https://www.notion.so";
  assert.equal(M.assetUrl("/icons/%2e%2e/api/v3/getSpaces", origin), null);
  assert.equal(M.assetUrl("/icons/%2E%2E/%2E%2E/api/v3/x", origin), null);
  assert.equal(M.assetUrl("/images/a%2fb/c.png", origin), null);
  assert.equal(M.assetUrl("/icons/.%2e/x.svg", origin), null);
  assert.equal(M.assetUrl("/icons/checkmark_green.svg", origin), "https://www.notion.so/icons/checkmark_green.svg");
  assert.equal(M.assetUrl("/images/page-cover/solid_blue.png?x=1", origin), "https://www.notion.so/images/page-cover/solid_blue.png?x=1");
});

function world(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "notes-review7-"));
  const data = join(dir, "data");
  const zips = join(dir, "zips");
  mkdirSync(data, { recursive: true });
  mkdirSync(zips, { recursive: true });
  const storage = new Map();
  let picked = null;
  const boot = () => {
    const files = M.nodeFiles({ data, pzip00000001: zips }, { latencyMs: options.latencyMs ?? 0 });
    const hub = M.pageHub();
    const notes = new M.Notes({
      files,
      folders: M.fakeFolders(files, join(dir, "shared")),
      storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
      setting: () => "",
      post: hub.post,
      openPage: async () => {},
      openUrl: async () => {},
      store: { debounceMs: 5, rescanMs: 0 },
      durableTimeoutMs: options.durableTimeoutMs ?? 1500,
      pickFiles: async () => (picked ? [picked] : []),
      log: () => {},
    });
    hub.attach(notes);
    const instance = {
      files,
      notes,
      async start() {
        await notes.start();
        await until(() => notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
        await notes.whenIdle();
        return notes.workspaces()[0].id;
      },
      async importZip(ws, zip) {
        writeFileSync(join(zips, "Export.zip"), zip);
        picked = { id: "pzip00000001", name: "Export.zip", size: zip.length };
        return (await notes.call("importStart", { workspace: ws, source: "notion", pick: "file" })).job;
      },
      status: (job) => notes.call("importStatus", { job }),
      stop: (opts) => notes.stop(opts).finally(() => files.detach()),
    };
    cleanups.push(() => instance.stop().catch(() => undefined));
    return instance;
  };
  return { boot, storage };
}

const exportZip = (pages) => {
  const files = {};
  for (let i = 0; i < pages; i++) files[`Export-aaaaaaaa-0000-4000-8000-000000000001/Page ${i} ${(i + 1).toString(16).padStart(32, "0")}.md`] = [enc(`# Page ${i}\n\nbody ${i}\n`), { level: 1 }];
  return fflate.zipSync(files);
};

test("2: an import whose pages can't be saved doesn't report done", async () => {
  const w = world({ durableTimeoutMs: 800 });
  const one = w.boot();
  const ws = await one.start();
  one.files.faults.append = (root, path) => (root === "data" && /(^|\/)docs\//.test(path) ? 0 : null);
  const job = await one.importZip(ws, exportZip(5));
  const status = await until(async () => {
    const j = await one.status(job);
    return terminal(j) ? j : null;
  }, 15_000, "import ends");
  const root = status.root;
  await one.stop({ flush: false });
  const two = w.boot();
  await two.start();
  const tree = two.notes.treeOf(ws);
  if (status.state === "done") assert.ok(root && model.getPage(tree, root), "a done import's root survives a restart");
  else assert.equal(status.state, "failed");
  const live = model.allPages(tree).filter((p) => !p.deleted && !p.archivedAt && p.title === "Notion import");
  if (status.state !== "done") assert.equal(live.length, 0, "nothing half-saved is left live");
});

test("2: quitting during an import leaves nothing half-made live after a restart", async () => {
  const w = world({ latencyMs: 1 });
  const one = w.boot();
  const ws = await one.start();
  const job = await one.importZip(ws, exportZip(400));
  await until(async () => {
    const j = await one.status(job);
    return terminal(j) || (j.state === "writing" && j.filesDone > 20);
  }, 20_000, "import underway");
  const before = await one.status(job);
  assert.ok(!terminal(before), "the import was still running at quit");
  await one.stop();
  await until(async () => terminal(await one.status(job)), 10_000, "the quit import settles");
  const two = w.boot();
  await two.start();
  await until(async () => (await two.status(job))?.state, 5000, "the interrupted import is known");
  const tree = two.notes.treeOf(ws);
  const roots = model.allPages(tree).filter((p) => !p.deleted && !p.archivedAt && p.title === "Notion import");
  for (const r of roots) assert.equal(model.childrenOf(tree, r.id).length, 400, "a live import is a whole one");
});

function device(sharedRoot, name) {
  const dir = mkdtempSync(join(tmpdir(), "notes-review7-dev-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, sharedRoot, []);
  const storage = new Map();
  const hub = M.pageHub();
  const notes = new M.Notes({
    files,
    folders,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: (k) => (k === "name" ? name : undefined),
    post: hub.post,
    openPage: async () => undefined,
    openUrl: async () => undefined,
    store: { debounceMs: 5, rescanMs: 100 },
    durableTimeoutMs: 3000,
    log: () => {},
  });
  hub.attach(notes);
  const d = {
    files,
    folders,
    notes,
    async boot() {
      await notes.start();
      await until(() => notes.workspaces().every((x) => x.state === "ready"), 5000, "ready");
      await notes.whenIdle();
      return notes.workspaces();
    },
  };
  cleanups.push(() => notes.stop().finally(() => files.detach()));
  return d;
}

const text = async (d, ws, page) => model.plainText(model.blocksOf(await d.notes.spaceStore(ws).get(`p-${page}`)));
const write = (doc, words) => doc.getXmlFragment("blocks").insert(doc.getXmlFragment("blocks").length, [new Y.XmlText(words)]);

async function sharedWithBob() {
  const shared = mkdtempSync(join(tmpdir(), "notes-review7-share-"));
  const alice = device(shared, "Alice");
  const [home] = await alice.boot();
  const { page: plan } = await alice.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Trip plan" });
  write(await alice.notes.spaceStore(home.id).get(`p-${plan}`), "flights on friday");
  await alice.notes.whenIdle();
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  const bob = device(shared, "Bob");
  await bob.boot();
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", alice.files.roots.get(share.folderId), "Trip plan"));
  await bob.notes.call("joinSharedWorkspace", {});
  await until(() => model.getPage(bob.notes.treeOf(share.id) ?? new Y.Doc(), plan), 5000, "bob has it");
  write(await bob.notes.spaceStore(share.id).get(`p-${plan}`), " bob first");
  await bob.notes.whenIdle();
  await until(async () => (await text(alice, share.id, plan)).includes("bob first"), 8000, "bob's first edit reaches alice");
  const docDir = join(alice.files.roots.get(share.folderId), "docs", `p-${plan}`);
  const bobLog = readdirSync(docDir).find((f) => f.endsWith(".log") && !f.startsWith(alice.notes.me().deviceId));
  return { alice, bob, home, plan, share, bobLog };
}

test("3: stopping a share while a collaborator's edit is still in iCloud keeps the share and says so", async () => {
  const { alice, bob, home, plan, share, bobLog } = await sharedWithBob();
  alice.files.hide(share.folderId, `docs/p-${plan}/${bobLog}`);
  write(await bob.notes.spaceStore(share.id).get(`p-${plan}`), " bob second");
  await bob.notes.whenIdle();
  const first = await alice.notes.call("stopSharingPage", { workspace: share.id }).then(
    () => null,
    (error) => error,
  );
  if (!first) assert.match(await text(alice, home.id, plan), /bob second/, "the private copy has every edit");
  assert.match(String(first?.message), /iCloud|download/i);
  assert.ok(alice.notes.workspaces().some((x) => x.id === share.id), "still shared");
  alice.files.reveal(share.folderId, `docs/p-${plan}/${bobLog}`);
  await alice.notes.call("stopSharingPage", { workspace: share.id });
  assert.match(await text(alice, home.id, plan), /bob second/);
});

test("3: stopping a share while an attachment is still in iCloud keeps the share", async () => {
  const { alice, bob, home, plan, share } = await sharedWithBob();
  const pic = await bob.notes.access().putFile(share.id, enc("bob-picture"), "pic.png", "image/png");
  model.updatePage(bob.notes.treeOf(share.id), plan, { cover: pic }, "bob");
  await bob.notes.whenIdle();
  await until(() => model.getPage(alice.notes.treeOf(share.id), plan)?.cover === pic, 8000, "the cover reaches alice");
  const name = readdirSync(join(alice.files.roots.get(share.folderId), "files")).find((f) => f.startsWith(pic.slice(5)));
  alice.files.hide(share.folderId, `files/${name}`);
  const first = await alice.notes.call("stopSharingPage", { workspace: share.id }).then(
    () => null,
    (error) => error,
  );
  if (!first) assert.ok(await alice.notes.spaceStore(home.id).getFile(pic.slice(5)), "the attachment came back");
  assert.match(String(first?.message), /iCloud|download/i);
  assert.ok(alice.notes.workspaces().some((x) => x.id === share.id), "still shared");
  alice.files.reveal(share.folderId, `files/${name}`);
  await alice.notes.call("stopSharingPage", { workspace: share.id });
  assert.ok(await alice.notes.spaceStore(home.id).getFile(pic.slice(5)));
});

test("9: a signed file URL with encoded characters in its query still downloads, and one with an encoded dot path doesn't", () => {
  const origin = "https://www.notion.so";
  assert.equal(M.downloadable("https://file.notion.so/f/f/space/file/pic.png?X-Amz-Credential=AK%2F20260101%2Fus-west-2&X-Amz-Signature=abc", origin), true);
  assert.equal(M.downloadable("https://www.notion.so/icons/%2e%2e/api/v3/getSpaces", origin), false);
  assert.equal(M.downloadable("https://www.notion.so/api/v3/getSpaces", origin), false);
  assert.equal(M.downloadable("https://www.notion.so/icons/checkmark_green.svg", origin), true);
});
