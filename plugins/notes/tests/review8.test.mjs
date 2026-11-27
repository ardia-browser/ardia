import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";
import { block, makeRecords, memorySink, merge, pageTitled, recordsImport, textOf, u, zipImport, hex, addParagraph } from "./support/importWorld.mjs";

const M = await load();
const { Y, model } = M;
const DOC = "p-aaaaaaaaaaaa";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
});

function storeAt(dir, deviceId) {
  const files = M.nodeFiles({ data: dir });
  const store = new M.WorkspaceStore({ fs: M.ardiaFileStore(files, "data", "ws1", { callMax: 8192 }), deviceId, debounceMs: 2, rescanMs: 0, compactAt: 1 });
  return { files, store };
}

const bigText = (seed) => Array.from({ length: 3000 }, (_, i) => `${seed}${(i * 7919) % 1000}`).join(" ");

test("4: a snapshot whose pointer reads but whose piece is still in iCloud stays unread until it's read whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-review8-"));
  const bob = storeAt(dir, "bobdevice01");
  await bob.store.open();
  const bobDoc = await bob.store.get(DOC);
  bobDoc.getXmlFragment("blocks").insert(0, [new Y.XmlText(bigText("first"))]);
  await bob.store.whenIdle();
  const alice = storeAt(dir, "alicedevice1");
  await alice.store.open();
  const aliceDoc = await alice.store.get(DOC);
  assert.match(aliceDoc.getXmlFragment("blocks").toString(), /first/);
  bobDoc.getXmlFragment("blocks").insert(1, [new Y.XmlText(` second ${bigText("second")}`)]);
  await bob.store.whenIdle();
  alice.files.faults.read = (_root, path) => path.includes(".chunks-bobdevice01/");
  assert.equal(await alice.store.rescan(), true);
  assert.doesNotMatch(aliceDoc.getXmlFragment("blocks").toString(), /second/);
  assert.notDeepEqual(alice.store.waitingFor([DOC]), [], "the half-read snapshot is still waited on");
  assert.equal(await alice.store.rescan(), true);
  assert.notDeepEqual(alice.store.waitingFor([DOC]), [], "a second rescan doesn't forget it");
  alice.files.faults.read = undefined;
  assert.equal(await alice.store.rescan(), true);
  assert.match(aliceDoc.getXmlFragment("blocks").toString(), /second/);
  assert.deepEqual(alice.store.waitingFor([DOC]), []);
  alice.files.faults.list = () => true;
  assert.equal(await alice.store.rescan(), false, "a failed listing isn't a successful rescan");
  await alice.store.close();
  await bob.store.close();
  alice.files.detach();
  bob.files.detach();
});

function clearBody(doc) {
  const fragment = doc.getXmlFragment("blocks");
  doc.transact(() => fragment.delete(0, fragment.length));
}

test("1: a body cleared here stays cleared when Notion didn't change it, and counts a conflict when it did", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  clearBody(s.docs.get(home.id));
  const same = await recordsImport(s, makeRecords());
  assert.equal(textOf(s.docs.get(home.id)), "", "the cleared body stays cleared");
  assert.equal(same.conflicts, 0);
  const changed = await recordsImport(s, makeRecords({ body: "rewritten in notion" }));
  assert.equal(textOf(s.docs.get(home.id)), "");
  assert.equal(changed.conflicts, 1);

  const z = memorySink();
  const files = { [`Home ${hex(u(1))}.md`]: "# Home\n\nzip body\n" };
  await zipImport(z, files);
  const zhome = pageTitled(z.tree, "Home");
  clearBody(z.docs.get(zhome.id));
  await zipImport(z, files);
  assert.equal(textOf(z.docs.get(zhome.id)), "");
});

test("3: a body that goes A, empty, then A again in Notion comes back", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  await recordsImport(s, makeRecords({ homeContent: [u(60)] }));
  assert.equal(textOf(s.docs.get(home.id)), "");
  await recordsImport(s, makeRecords());
  assert.match(textOf(s.docs.get(home.id)), /hello from notion/);
});

const boldOrLiteral = (bold) => makeRecords({ homeContent: [u(5), u(60)], extraBlocks: [block(u(5), "text", { properties: { title: bold ? [["x", [["b"]]]] : [["<bold>x</bold>"]] } })] });

test("3: two Macs importing different first versions whose text looks alike converge to the same document", async () => {
  const a = memorySink();
  const b = memorySink();
  await recordsImport(a, boldOrLiteral(true));
  await recordsImport(b, boldOrLiteral(false));
  merge(a, b);
  const home = pageTitled(a.tree, "Home");
  const json = JSON.stringify(a.docs.get(home.id).getXmlFragment("blocks").toJSON());
  assert.equal(json, JSON.stringify(b.docs.get(home.id).getXmlFragment("blocks").toJSON()));
});

test("3: two Macs importing the same first version at once keep one copy, and a copy edited here is never dropped", async () => {
  const a = memorySink();
  const b = memorySink();
  await recordsImport(a, makeRecords());
  await recordsImport(b, makeRecords());
  const home = pageTitled(a.tree, "Home");
  addParagraph(b.docs.get(home.id), "edited before the merge");
  merge(a, b);
  const text = textOf(a.docs.get(home.id));
  assert.match(text, /edited before the merge/);
  assert.equal(text.match(/hello from notion/g)?.length, 2, "an edited copy isn't treated as a duplicate");

  const c = memorySink();
  const d = memorySink();
  await recordsImport(c, makeRecords());
  await recordsImport(d, makeRecords());
  merge(c, d);
  assert.equal(textOf(c.docs.get(pageTitled(c.tree, "Home").id)).match(/hello from notion/g)?.length, 1);
});

test("7: a page with no import base keeps local values that differ from Notion and counts a conflict, then records the base", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  const entry = s.tree.getMap("pages").get(home.id);
  s.tree.transact(() => {
    entry.delete("imported");
    entry.set("title", "Mine");
    entry.set("fullWidth", true);
    entry.set("locked", true);
  });
  const renamed = makeRecords();
  renamed.blocks[u(1)].value.value.properties.title = [["Home v2"]];
  const first = await recordsImport(s, renamed);
  const after = model.getPage(s.tree, home.id);
  assert.deepEqual([after.title, after.fullWidth, after.locked], ["Mine", true, true]);
  assert.ok(first.conflicts >= 1);
  const again = await recordsImport(s, renamed);
  assert.equal(model.getPage(s.tree, home.id).title, "Mine");
  assert.equal(again.conflicts, 0, "once the base is recorded an unchanged source is quiet");

  const z = memorySink();
  await zipImport(z, { [`Home ${hex(u(1))}.md`]: "# Home\n\nzip body\n" });
  const zipped = pageTitled(z.tree, "Home");
  const wide = makeRecords();
  wide.blocks[u(1)].value.value.format = { page_full_width: true };
  await recordsImport(z, wide);
  assert.equal(model.getPage(z.tree, zipped.id).fullWidth, false, "a setting the zip never recorded isn't reset by a records import");
});

test("2: a page whose blocks a partial crawl didn't read keeps its body and base", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  const partial = makeRecords();
  delete partial.blocks[u(2)];
  partial.incomplete = { collections: [], blocks: [u(2)] };
  await recordsImport(s, partial);
  assert.match(textOf(s.docs.get(home.id)), /hello from notion/, "the unread body isn't erased");
  await recordsImport(s, makeRecords({ body: "complete again" }));
  assert.match(textOf(s.docs.get(home.id)), /complete again/, "a later complete crawl still updates it, so the base was kept");
});

test("12: built-in Notion asset paths take no percent escapes at all, and signed queries stay as they are", () => {
  const origin = "https://www.notion.so";
  assert.equal(M.assetUrl("/icons/%41bc.svg", origin), null);
  assert.equal(M.assetUrl("/images/page-cover/a%20b.png", origin), null);
  assert.equal(M.downloadable("https://www.notion.so/icons/%41bc.svg", origin), false);
  assert.equal(M.assetUrl("/images/page-cover/solid_blue.png?w=1%2C2", origin), "https://www.notion.so/images/page-cover/solid_blue.png?w=1%2C2");
  assert.equal(M.downloadable("https://file.notion.so/f/f/s/x/pic.png?X-Amz-Credential=AK%2F2026%2Fus&sig=a%2Bb", origin), true);
});

test("13: an ordinary zip read refuses an entry that inflates past its declared size, even with a CRC of the cut bytes", async () => {
  const data = new TextEncoder().encode("abcdefghij".repeat(200));
  const zip = M.fflate.zipSync({ "a.txt": [data, { level: 6 }] });
  let dir = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
    dir = zip[i + 16] | (zip[i + 17] << 8) | (zip[i + 18] << 16) | (zip[i + 19] << 24);
    break;
  }
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const cut = data.subarray(0, 100);
  view.setUint32(dir + 16, M.bytes.crc32(cut), true);
  view.setUint32(dir + 24, cut.length, true);
  const reader = await M.ZipReader.open({ size: zip.length, read: async (o, l) => zip.subarray(o, Math.min(zip.length, o + l)) });
  await assert.rejects(reader.read(reader.entries[0], 1 << 20), /more than the zip says|isn't the size/);
});

test("8: a page under a row a partial crawl left out stays, and a zip whose table couldn't be read trashes nothing of it", async () => {
  const s = memorySink();
  const child = block(u(400), "page", { parent_table: "block", parent_id: u(302), properties: { title: [["Under the row"]] } });
  const first = makeRecords({ rows: [u(301), u(302)], extraBlocks: [child] });
  first.blocks[u(302)].value.value.content = [u(400)];
  await recordsImport(s, first);
  const under = pageTitled(s.tree, "Under the row");
  const partial = makeRecords({ rows: [u(301)] });
  partial.incomplete = { collections: [u(100)], blocks: [] };
  await recordsImport(s, partial);
  assert.equal(model.getPage(s.tree, under.id).archivedAt, 0, "the omitted row's subpage stays");

  const z = memorySink();
  const files = { [`Tasks ${hex(u(500))}.csv`]: "Name,Status\nWrite,Done\n", [`Home ${hex(u(1))}.md`]: "# Home\n\nbody\n" };
  await zipImport(z, files);
  const tasks = pageTitled(z.tree, "Tasks");
  await zipImport(z, files, { fail: (path) => path.endsWith(".csv") });
  assert.equal(model.getPage(z.tree, tasks.id).archivedAt, 0, "an unreadable table isn't taken as deleted");
  assert.equal(model.getPage(z.tree, pageTitled(z.tree, "Write").id).archivedAt, 0);
});

test("6: table rows without a Notion id follow their own identity when the export reorders them", async () => {
  const z = memorySink();
  const csv = (rows) => ({ [`Tasks ${hex(u(500))}.csv`]: `Name,Status\n${rows.join("\n")}\n` });
  await zipImport(z, csv(["Apples,Todo", "Bread,Todo", "Same,Todo", "Same,Todo"]));
  const bread = pageTitled(z.tree, "Bread");
  z.tree.transact(() => z.tree.getMap("pages").get(bread.id).set("title", "Bread, mine"));
  await zipImport(z, csv(["Bread,Todo", "Same,Todo", "Apples,Todo", "Same,Todo"]));
  assert.equal(model.getPage(z.tree, bread.id).title, "Bread, mine", "the edited row keeps its edit");
  const apples = pageTitled(z.tree, "Apples");
  assert.notEqual(apples.id, bread.id);
  const same = z.tree.getMap("pages");
  const live = model.allPages(z.tree).filter((p) => !p.deleted && !p.archivedAt);
  assert.equal(live.filter((p) => p.title === "Same").length, 2);
  assert.equal(live.filter((p) => p.title === "Bread").length, 0, "no row takes another row's identity");
  assert.ok(same.size > 0);
});

test("9: a zip import journals each new subtree root before it appears in the tree", async () => {
  const z = memorySink();
  const one = { [`Home ${hex(u(1))}.md`]: "# Home\n\nbody\n" };
  const seen = [];
  const journal = async (ids) => {
    for (const id of ids) seen.push({ id, present: z.tree.getMap("pages").has(id) });
  };
  const plan = await M.planFor("notion", { files: Object.keys(one).map((path) => ({ path, size: 10 })), read: async (p) => new TextEncoder().encode(one[p]) });
  const first = await M.writePlan(plan, z.sink, { title: "Notion import", icon: "📥" }, () => {}, () => false, 1, { sync: { workspace: "ws0000000001", candidates: M.readImports(z.tree) }, journal });
  M.recordImport(z.tree, { id: first.recordId, source: "notion", at: 1, roots: [first.root], pages: first.pageIds, by: "tester", files: first.files });
  assert.deepEqual(seen, [{ id: first.root, present: false }]);
  seen.length = 0;
  const two = { ...one, [`Fresh ${hex(u(2))}.md`]: "# Fresh\n\nnew\n" };
  const plan2 = await M.planFor("notion", { files: Object.keys(two).map((path) => ({ path, size: 10 })), read: async (p) => new TextEncoder().encode(two[p]) });
  let checks = 0;
  await assert.rejects(M.writePlan(plan2, z.sink, { title: "Notion import", icon: "📥" }, () => {}, () => ++checks > 2, 2, { sync: { workspace: "ws0000000001", candidates: M.readImports(z.tree) }, journal }));
  assert.equal(seen.length, 1, "the new page under the kept root is journaled");
  assert.equal(seen[0].present, false);
  assert.equal(seen[0].id, M.syncedId("ws0000000001", hex(u(2))));
});

test("9: flushDurable's deadline counts from the start, not from when its writes finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-review8-"));
  const files = M.nodeFiles({ data: dir });
  const store = new M.WorkspaceStore({ fs: M.ardiaFileStore(files, "data", "ws1"), deviceId: "slowdevice1", debounceMs: 2, rescanMs: 0 });
  await store.open();
  const doc = store.create(DOC);
  files.faults.delay = (_root, path) => (path.includes(DOC) ? 3000 : 0);
  doc.getXmlFragment("blocks").insert(0, [new Y.XmlText("slow")]);
  const started = Date.now();
  const ok = await store.flushDurable([DOC], 300);
  const took = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(took < 1500, `gave up after ${took} ms`);
  files.faults.delay = undefined;
  await store.close();
  files.detach();
});

function notesWorld() {
  const dir = mkdtempSync(join(tmpdir(), "notes-review8-w-"));
  const data = join(dir, "data");
  const zips = join(dir, "zips");
  mkdirSync(data, { recursive: true });
  mkdirSync(zips, { recursive: true });
  const storage = new Map();
  let picked = null;
  const boot = () => {
    const files = M.nodeFiles({ data, pzip00000001: zips });
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
      durableTimeoutMs: 3000,
      pickFiles: async () => (picked ? [picked] : []),
      log: () => {},
    });
    hub.attach(notes);
    cleanups.push(() => notes.stop().finally(() => files.detach()));
    return {
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
  };
  return { boot };
}

const terminal = (j) => j && ["done", "failed", "cancelled"].includes(j.state);
const exportZip = (from, to) => {
  const files = {};
  for (let i = from; i < to; i++) files[`Export-aaaaaaaa-0000-4000-8000-000000000001/Page ${i} ${(i + 1).toString(16).padStart(32, "0")}.md`] = [new TextEncoder().encode(`# Page ${i}\n\nbody ${i}\n`), { level: 1 }];
  return M.fflate.zipSync(files);
};
const finished = async (n, job) =>
  until(async () => {
    const j = await n.status(job);
    return terminal(j) ? j : null;
  }, 20_000, "import ends");

test("9: a cancelled re-import leaves no new page live under the kept root", async () => {
  const w = notesWorld();
  const n = w.boot();
  const ws = await n.start();
  assert.equal((await finished(n, await n.importZip(ws, exportZip(0, 3)))).state, "done");
  n.files.faults.readDelay = (root) => (root === "pzip00000001" ? 15 : 0);
  const job = await n.importZip(ws, exportZip(0, 60));
  await until(async () => {
    const j = await n.status(job);
    return terminal(j) || (j.state === "writing" && j.filesDone > 4);
  }, 20_000, "re-import underway");
  await n.notes.call("importCancel", { job });
  const end = await finished(n, job);
  assert.equal(end.state, "cancelled");
  const tree = n.notes.treeOf(ws);
  const live = model.allPages(tree).filter((p) => !p.deleted && !p.archivedAt && /^Page \d+$/.test(p.title));
  assert.deepEqual(live.map((p) => p.title).sort(), ["Page 0", "Page 1", "Page 2"]);
  await n.stop();
});

test("9: quitting during an import returns well inside a second and the next start trashes what it made", async () => {
  const w = notesWorld();
  const n = w.boot();
  const ws = await n.start();
  n.files.faults.readDelay = (root) => (root === "pzip00000001" ? 15 : 0);
  const job = await n.importZip(ws, exportZip(0, 200));
  await until(async () => {
    const j = await n.status(job);
    return terminal(j) || (j.state === "writing" && j.filesDone > 4);
  }, 20_000, "import underway");
  n.files.faults.readDelay = (root) => (root === "pzip00000001" ? 1500 : 0);
  await until(async () => (await n.status(job)).filesDone > 6 || terminal(await n.status(job)), 5000, "a slow read in flight");
  const before = await n.status(job);
  assert.ok(!terminal(before), `the import was still running at quit (${before.state}, ${before.filesDone})`);
  const started = Date.now();
  await n.stop();
  const took = Date.now() - started;
  assert.ok(took < 1000, `quit took ${took} ms`);
  await until(async () => terminal(await n.status(job)), 10_000, "the quit import settles");
  const again = w.boot();
  await again.start();
  await until(async () => (await again.status(job))?.state, 5000, "the interrupted import is known");
  const tree = again.notes.treeOf(ws);
  assert.deepEqual(model.allPages(tree).filter((p) => (p.title === "Notion import" || /^Page \d+$/.test(p.title)) && !model.isArchivedDeep(tree, p.id)).map((p) => p.title), []);
  await again.stop();
});

const D = M.database;
const withStatus = (rows = [u(301), u(302)]) => {
  const r = makeRecords({ rows });
  r.collections[u(100)].value.value.schema.stat = { name: "Status", type: "select", options: [{ id: "o1", value: "Todo", color: "gray" }, { id: "o2", value: "Done", color: "green" }] };
  for (const id of rows) r.blocks[id].value.value.properties.stat = [["Todo"]];
  return r;
};
const dbPage = (tree) => pageTitled(tree, "Tasks");

test("5: a records re-import keeps columns and views added or edited here, and still applies Notion's changes", async () => {
  const s = memorySink();
  await recordsImport(s, withStatus());
  const db = dbPage(s.tree);
  const doc = s.docs.get(db.id);
  const mineCol = D.addProperty(doc, { type: "text", name: "My notes" });
  const mineView = D.addView(doc, "board", { name: "My board" });
  const imported = D.readViews(doc).find((v) => v.id !== mineView);
  D.updateView(doc, imported.id, { name: "Renamed here" });
  await recordsImport(s, withStatus());
  assert.ok(D.readSchema(doc).some((p) => p.id === mineCol), "a local column stays");
  assert.ok(D.readViews(doc).some((v) => v.id === mineView), "a local view stays");
  assert.equal(D.readViews(doc).find((v) => v.id === imported.id).name, "Renamed here", "a local edit to an imported view stays");
  const renamed = withStatus();
  renamed.collections[u(100)].value.value.schema.stat.name = "Stage";
  await recordsImport(s, renamed);
  assert.ok(D.readSchema(doc).some((p) => p.name === "Stage"), "Notion's rename of a column untouched here applies");
  assert.ok(D.readSchema(doc).some((p) => p.id === mineCol));
});

const entriesWithId = (doc, id) => {
  let n = D.viewMapOf(doc).has(id) ? 1 : 0;
  D.viewsOf(doc).forEach((e) => (n += e.get("id") === id ? 1 : 0));
  return n;
};

test("11: two Macs importing the same database for the first time end with one entry per view", async () => {
  const a = memorySink();
  const b = memorySink();
  await recordsImport(a, withStatus());
  await recordsImport(b, withStatus());
  merge(a, b);
  const doc = a.docs.get(dbPage(a.tree).id);
  const views = D.readViews(doc);
  assert.ok(views.length >= 1);
  for (const v of views) assert.equal(entriesWithId(doc, v.id), 1, `view ${v.id} is stored once`);
});

test("11: a database imported from records then a zip, or a zip then records, has each column once", async () => {
  const csv = { [`Tasks ${hex(u(60))}.csv`]: "Name,Status\nRow 301,Todo\nRow 302,Done\n" };
  const r = memorySink();
  await recordsImport(r, withStatus());
  await zipImport(r, csv);
  const names = D.readSchema(r.docs.get(dbPage(r.tree).id)).map((p) => p.name);
  assert.equal(names.filter((n) => n === "Status").length, 1, `records then zip: ${names}`);

  const z = memorySink();
  await zipImport(z, csv);
  const zdb = dbPage(z.tree);
  await recordsImport(z, withStatus());
  const after = D.readSchema(z.docs.get(zdb.id));
  assert.equal(after.filter((p) => p.name === "Status").length, 1, `zip then records: ${after.map((p) => p.name)}`);
  assert.equal(dbPage(z.tree).id, zdb.id);
});

function shareDevice() {
  const dir = mkdtempSync(join(tmpdir(), "notes-review8-s-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, join(dir, "shared"), []);
  const storage = new Map();
  const hub = M.pageHub();
  const notes = new M.Notes({
    files,
    folders,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => "Alice",
    post: hub.post,
    openPage: async () => undefined,
    openUrl: async () => undefined,
    store: { debounceMs: 5, rescanMs: 0 },
    durableTimeoutMs: 3000,
    log: () => {},
  });
  hub.attach(notes);
  cleanups.push(() => notes.stop().finally(() => files.detach()));
  return { files, notes };
}

async function sharedPage() {
  const d = shareDevice();
  await d.notes.start();
  await until(() => d.notes.workspaces().every((w) => w.state === "ready"), 5000, "ready");
  const [home] = d.notes.workspaces();
  const { page } = await d.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Trip plan" });
  const doc = await d.notes.spaceStore(home.id).get(`p-${page}`);
  doc.getXmlFragment("blocks").insert(0, [new Y.XmlText("flights on friday")]);
  await d.notes.whenIdle();
  const { workspace: share } = await d.notes.call("sharePage", { workspace: home.id, page });
  return { ...d, home, page, share };
}

const FAKE = "ab".repeat(32);

test("10: text that only looks like a file reference doesn't hold up Stop sharing", async () => {
  const { notes, home, page, share } = await sharedPage();
  const doc = await notes.spaceStore(share.id).get(`p-${page}`);
  doc.getXmlFragment("blocks").insert(1, [new Y.XmlText(` see file:${FAKE} for details`)]);
  await notes.whenIdle();
  const res = await notes.call("stopSharingPage", { workspace: share.id });
  assert.equal(res.stopped, true);
  assert.deepEqual(res.missing, []);
  assert.equal(res.workspace, home.id);
});

test("10: an attachment gone for good blocks Stop sharing until you choose to stop anyway, which keeps the rest", async () => {
  const { notes, home, page, share } = await sharedPage();
  model.updatePage(notes.treeOf(share.id), page, { cover: `file:${FAKE}` }, "x");
  await notes.whenIdle();
  const blocked = await notes.call("stopSharingPage", { workspace: share.id });
  assert.equal(blocked.stopped, false);
  assert.equal(blocked.missing.length, 1);
  assert.ok(notes.workspaces().some((w) => w.id === share.id), "still shared");
  const done = await notes.call("stopSharingPage", { workspace: share.id, anyway: true });
  assert.equal(done.stopped, true);
  assert.equal(done.missing.length, 1);
  assert.ok(!notes.workspaces().some((w) => w.id === share.id));
  assert.match(model.plainText(model.blocksOf(await notes.spaceStore(home.id).get(`p-${page}`))), /flights on friday/);
});

test("10: a damaged attachment is reported as missing, not as still downloading", async () => {
  const { files, notes, page, share } = await sharedPage();
  const real = await notes.access().putFile(share.id, new TextEncoder().encode("picture bytes"), "pic.png", "image/png");
  model.updatePage(notes.treeOf(share.id), page, { cover: real }, "x");
  await notes.whenIdle();
  const sha = real.slice(5);
  const dir = join(files.roots.get(share.folderId), "files");
  writeFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith(sha))), "damaged");
  const res = await notes.call("stopSharingPage", { workspace: share.id });
  assert.equal(res.stopped, false);
  assert.equal(res.missing.length, 1);
});
