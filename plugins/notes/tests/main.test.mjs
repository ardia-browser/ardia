import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";

const M = await load();
const { Y, model } = M;

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function device(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "notes-main-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const sharedRoot = options.sharedRoot ?? join(dir, "shared");
  mkdirSync(sharedRoot, { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, sharedRoot, options.pickQueue ?? []);
  const storage = options.storage ?? new Map();
  const settings = { name: "", searchEverywhere: true, ...(options.settings ?? {}) };
  const hub = M.pageHub();
  const opened = [];
  const urls = [];
  const logs = [];
  const host = {
    files,
    folders,
    storage: {
      get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined),
      set: async (k, v) => void storage.set(k, structuredClone(v)),
    },
    setting: (k) => settings[k],
    post: hub.post,
    openPage: async (p) => void opened.push(p),
    openUrl: async (u) => void urls.push(u),
    store: { debounceMs: 5, rescanMs: 200 },
    cursors: options.cursors,
    log: (level, text) => logs.push(`${level} ${text}`),
    viewTimeoutMs: options.viewTimeoutMs,
    sweepMs: options.sweepMs,
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  const pages = [];
  const d = {
    dir,
    files,
    folders,
    storage,
    settings,
    hub,
    notes,
    opened,
    urls,
    logs,
    open(view) {
      const page = hub.open(view);
      pages.push(page);
      return page;
    },
    async stop() {
      for (const p of pages) p.close();
      await notes.stop();
      files.detach();
    },
  };
  cleanups.push(() => d.stop());
  return d;
}

async function booted(d) {
  await d.notes.start();
  await until(() => d.notes.workspaces().every((w) => w.state === "ready"), 5000, "workspaces ready");
  await d.notes.whenIdle();
  d.notes.reindexNow();
  return d.notes.workspaces();
}

async function opened(client, workspace, doc) {
  const handle = client.open(workspace, doc);
  await Promise.race([handle.synced, new Promise((_, reject) => setTimeout(() => reject(new Error(`${doc} never synced`)), 5000))]);
  return handle;
}

async function sharedPair(cursors = {}) {
  const shared = mkdtempSync(join(tmpdir(), "notes-shared-"));
  const alice = device({ sharedRoot: shared, settings: { name: "Alice" }, cursors });
  const bob = device({ sharedRoot: shared, settings: { name: "Bob" }, cursors });
  await Promise.all([booted(alice), booted(bob)]);
  const team = await alice.notes.call("createSharedWorkspace", { name: "Team" });
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", alice.files.roots.get(team.folderId), "Team"));
  await bob.notes.call("joinSharedWorkspace", {});
  const { page } = await alice.notes.call("createPage", { workspace: team.id, parent: "", kind: "page", title: "Plan" });
  await until(() => model.getPage(bob.notes.treeOf(team.id) ?? new Y.Doc(), page), 5000, "page reaches bob");
  const av = alice.open("a1");
  const bv = bob.open("b1");
  await Promise.all([av.client.ready, bv.client.ready]);
  const a = await opened(av.client, team.id, `p:${page}`);
  const b = await opened(bv.client, team.id, `p:${page}`);
  return { alice, bob, team, page, av, bv, a, b };
}

const cursorOf = (awareness, id) => awareness.getStates().get(id)?.cursor;

test("cursors cross devices through the shared folder, with names and colours", async () => {
  const { alice, bob, team, page, a, b } = await sharedPair();
  const started = performance.now();
  a.awareness.setLocalStateField("cursor", { anchor: 3, head: 7 });
  await until(() => cursorOf(b.awareness, a.doc.clientID)?.head === 7, 5000, "alice's cursor on bob's page");
  const latency = performance.now() - started;
  console.log(`cursor latency over a local folder: ${latency.toFixed(0)} ms`);
  const state = b.awareness.getStates().get(a.doc.clientID);
  assert.equal(state.user.name, "Alice");
  assert.equal(state.user.color, alice.notes.me().color);
  b.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
  await until(() => cursorOf(a.awareness, b.doc.clientID)?.head === 1, 5000, "bob's cursor on alice's page");
  for (let i = 0; i < 20; i++) a.awareness.setLocalStateField("cursor", { anchor: i, head: i });
  await until(() => cursorOf(b.awareness, a.doc.clientID)?.head === 19, 5000, "the last of a burst arrives");
  const dir = alice.files.roots.get(team.folderId);
  const files = readdirSync(join(dir, "presence"));
  assert.ok(files.includes(`${alice.notes.deviceId}.aw`) && files.includes(`${alice.notes.deviceId}.json`));
  const late = bob.open("b2");
  await late.client.ready;
  const c = await opened(late.client, team.id, `p:${page}`);
  await until(() => cursorOf(c.awareness, a.doc.clientID)?.head === 19, 3000, "a view opened later sees the cursor");
  c.release();
});

test("a device that goes quiet times out, and leaving clears its cursor at once", async () => {
  const quiet = await sharedPair({ staleMs: 400, keepaliveMs: 600_000 });
  quiet.a.awareness.setLocalStateField("cursor", { anchor: 2, head: 2 });
  await until(() => cursorOf(quiet.b.awareness, quiet.a.doc.clientID)?.head === 2, 5000, "cursor appears");
  await until(() => !quiet.b.awareness.getStates().has(quiet.a.doc.clientID), 5000, "cursor times out");
  const { a, b, bob } = await sharedPair();
  a.awareness.setLocalStateField("cursor", { anchor: 5, head: 5 });
  await until(() => cursorOf(b.awareness, a.doc.clientID)?.head === 5, 5000, "cursor appears");
  a.release();
  await until(() => !b.awareness.getStates().has(a.doc.clientID), 5000, "release clears the cursor");
  b.release();
  await bob.notes.whenIdle();
});

test("first start makes My Notes with a welcome tree, and the omnibox finds it", async () => {
  const d = device();
  const list = await booted(d);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "My Notes");
  assert.equal(list[0].shared, false);
  const tree = d.notes.treeOf(list[0].id);
  const top = model.childrenOf(tree, "").map((p) => p.title);
  assert.deepEqual(top, ["Getting Started", "Tasks", "Ideas"]);
  const start = model.childrenOf(tree, "")[0];
  const hits = d.notes.omnibox("callouts", "notes");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, `ardia://notes/Getting-Started-${start.id}`);
  assert.equal(hits[0].icon, "doc.text");
  assert.match(hits[0].subtitle, /Callouts/);
  assert.equal(d.notes.omnibox("tasks", "n")[0].icon, "tablecells");
  assert.deepEqual(d.notes.omnibox("c", "notes"), []);
  assert.ok(d.notes.omnibox("", "n").length >= 3);
  d.settings.searchEverywhere = false;
  assert.deepEqual(d.notes.omnibox("callouts", "notes"), []);
  assert.equal(d.notes.omnibox("callouts", "n").length, 1);
  d.settings.searchEverywhere = true;
  const resolved = await d.notes.resolve("/");
  assert.deepEqual(resolved, { workspace: list[0].id, page: start.id });
  assert.deepEqual(await d.notes.resolve(`/Whatever-${start.id}?v=1`), { workspace: list[0].id, page: start.id });
  assert.equal(await d.notes.resolve("/search"), null);
  const path = await d.notes.newPage();
  assert.match(path, /^\/Untitled-[0-9a-f]{12}$/);
  assert.deepEqual(d.opened, [path]);
});

test("two page views share edits and awareness through main", async () => {
  const d = device();
  const [ws] = await booted(d);
  const one = d.open("v1");
  const two = d.open("v2");
  await Promise.all([one.client.ready, two.client.ready]);
  assert.equal(one.client.me().name, "Someone");
  assert.equal(one.client.workspaces()[0].id, ws.id);
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0].id;
  const a = await opened(one.client, ws.id, `p:${page}`);
  const b = await opened(two.client, ws.id, `p:${page}`);
  assert.match(model.plainText(model.blocksOf(b.doc)), /Welcome to Notes/);
  a.doc.getMap("test").set("from", "one");
  await until(() => b.doc.getMap("test").get("from") === "one", 3000, "edit relayed");
  b.doc.getMap("test").set("back", "two");
  await until(() => a.doc.getMap("test").get("back") === "two", 3000, "edit relayed back");
  const mainDoc = await d.notes.spaceStore(ws.id).get(`p-${page}`);
  assert.equal(mainDoc.getMap("test").get("back"), "two");
  a.awareness.setLocalStateField("user", { name: "One", color: "#123456" });
  await until(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === "One", 3000, "awareness relayed");
  const three = d.open("v3");
  await three.client.ready;
  const c = await opened(three.client, ws.id, `p:${page}`);
  await until(() => c.awareness.getStates().get(a.doc.clientID)?.user?.name === "One", 3000, "cached awareness for a late view");
  a.release();
  await until(() => !b.awareness.getStates().has(a.doc.clientID), 3000, "awareness removed on release");
  const tree = await opened(two.client, ws.id, "ws");
  const { page: created } = await two.client.call("createPage", { workspace: ws.id, parent: "", kind: "page", title: "From the page" });
  await until(() => model.getPage(tree.doc, created)?.title === "From the page", 3000, "tree relayed");
  model.updatePage(tree.doc, created, { title: "Renamed in the page" }, "x");
  await until(() => model.getPage(d.notes.treeOf(ws.id), created)?.title === "Renamed in the page", 3000, "tree edit reaches main");
  await d.notes.whenIdle();
  d.notes.reindexNow();
  const hits = await one.client.call("search", { query: "renamed" });
  assert.equal(hits[0]?.page, created);
  b.release();
  c.release();
  tree.release();
});

test("page ops: duplicate, move, archive, restore, delete, backlinks", async () => {
  const d = device();
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const call = view.client.call;
  const { page: parent } = await call("createPage", { workspace: ws.id, parent: "", kind: "page", title: "Parent" });
  const { page: child } = await call("createPage", { workspace: ws.id, parent, kind: "page", title: "Child" });
  const childDoc = await opened(view.client, ws.id, `p:${child}`);
  childDoc.doc.getXmlFragment("blocks").insert(0, [new Y.XmlText("child body")]);
  const link = new Y.XmlElement("mention");
  link.setAttribute("pageId", parent);
  childDoc.doc.getXmlFragment("blocks").insert(1, [link]);
  const mainChild = await d.notes.spaceStore(ws.id).get(`p-${child}`);
  await until(() => mainChild.getXmlFragment("blocks").length === 2, 3000, "child edits reach main");
  const { page: copy } = await call("duplicatePage", { workspace: ws.id, page: parent });
  const tree = d.notes.treeOf(ws.id);
  assert.equal(model.getPage(tree, copy).title, "Parent (1)");
  const copiedChild = model.childrenOf(tree, copy)[0];
  assert.equal(copiedChild.title, "Child");
  const copiedDoc = await d.notes.spaceStore(ws.id).get(`p-${copiedChild.id}`);
  assert.match(copiedDoc.getXmlFragment("blocks").toString(), /child body/);
  assert.match(copiedDoc.getXmlFragment("blocks").toString(), new RegExp(copy));
  d.notes.reindexNow();
  const back = await view.client.call("backlinks", { workspace: ws.id, page: parent });
  assert.deepEqual(back.map((b) => b.page), [child]);
  await assert.rejects(call("movePage", { workspace: ws.id, page: parent, parent: child }), /inside itself/);
  await call("movePage", { workspace: ws.id, page: child, parent: "", after: null });
  assert.equal(model.childrenOf(tree, "")[0].id, child);
  await call("archivePage", { workspace: ws.id, page: parent });
  assert.ok(model.getPage(tree, parent).archivedAt > 0);
  d.notes.reindexNow();
  assert.ok(!(await call("search", { query: "parent" })).some((h) => h.page === parent));
  await call("restorePage", { workspace: ws.id, page: parent });
  await call("deletePage", { workspace: ws.id, page: copy });
  assert.equal(model.getPage(tree, copy).deleted, true);
  assert.equal(model.getPage(tree, copiedChild.id).deleted, true);
  const other = await call("createWorkspace", { name: "Second" });
  assert.equal(other.name, "Second");
  const moved = await call("movePage", { workspace: ws.id, page: parent, parent: "", toWorkspace: other.id });
  assert.equal(moved.workspace, other.id);
  assert.equal(model.getPage(d.notes.treeOf(other.id), parent).title, "Parent");
  assert.equal(model.getPage(tree, parent).deleted, true);
  await call("renameWorkspace", { workspace: other.id, name: "Renamed", icon: "🚀" });
  await until(() => view.client.workspaces().some((w) => w.name === "Renamed" && w.icon === "🚀"), 3000, "workspaces broadcast");
  await call("openUrl", { url: "https://example.com/" });
  assert.deepEqual(d.urls, ["https://example.com/"]);
  await assert.rejects(call("openUrl", { url: "file:///etc/passwd" }));
  await call("leaveWorkspace", { workspace: other.id });
  assert.equal(d.notes.workspaces().length, 1);
  childDoc.release();
});

test("uploads are chunked, stored by hash and read back", async () => {
  const d = device();
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const data = new Uint8Array(300_000).map((_, i) => (i * 7) & 255);
  const ref = await view.client.upload(ws.id, new Blob([data], { type: "image/png" }), "photo.png");
  assert.match(ref, /^file:[0-9a-f]{64}$/);
  assert.ok(view.maxSent <= 64 * 1024, `page sent ${view.maxSent}`);
  const files = readdirSync(join(d.dir, "data/workspaces", ws.id, "files"));
  assert.deepEqual(files, [`${ref.slice(5)}.png`]);
  const back = await view.client.call("file", { workspace: ws.id, ref });
  assert.equal(back.type, "image/png");
  assert.deepEqual([...Buffer.from(back.data, "base64")], [...data]);
  const url = await view.client.fileUrl(ws.id, ref);
  assert.match(url, /^blob:/);
  assert.equal(await view.client.fileUrl(ws.id, ref), url);
});

test("big documents travel in chunks both ways", async () => {
  const d = device();
  const [ws] = await booted(d);
  const one = d.open("v1");
  const two = d.open("v2");
  await Promise.all([one.client.ready, two.client.ready]);
  const { page } = await one.client.call("createPage", { workspace: ws.id, parent: "", kind: "page", title: "Big" });
  const a = await opened(one.client, ws.id, `p:${page}`);
  const b = await opened(two.client, ws.id, `p:${page}`);
  const big = "lorem ipsum ".repeat(50_000);
  a.doc.getText("t").insert(0, big);
  await until(() => b.doc.getText("t").length === big.length, 10_000, "big update relayed");
  assert.ok(one.maxSent <= 64 * 1024);
  const three = d.open("v3");
  await three.client.ready;
  const c = await opened(three.client, ws.id, `p:${page}`);
  assert.equal(c.doc.getText("t").length, big.length);
  assert.ok(three.received.some((m) => m.t === "chunk"));
  a.release();
  b.release();
  c.release();
});

test("version history: snapshots before editing, list, preview and restore", async () => {
  const d = device();
  const [ws] = await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0].id;
  const h = await opened(view.client, ws.id, `p:${page}`);
  const original = model.plainText(model.blocksOf(h.doc));
  h.doc.transact(() => {
    const blocks = model.blocksOf(h.doc);
    blocks.delete(0, blocks.length);
    blocks.insert(0, [new Y.XmlText("everything replaced")]);
  });
  const versions = await until(async () => {
    const list = await view.client.call("history", { workspace: ws.id, page });
    return list.length ? list : null;
  }, 3000, "a version");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].by, "Someone");
  const { state } = await view.client.call("versionState", { workspace: ws.id, page, version: versions[0].id });
  const preview = new Y.Doc();
  Y.applyUpdate(preview, Buffer.from(state, "base64"));
  assert.equal(model.plainText(model.blocksOf(preview)), original);
  await view.client.call("restoreVersion", { workspace: ws.id, page, version: versions[0].id });
  await until(() => model.plainText(model.blocksOf(h.doc)) === original, 3000, "restore reaches the page");
  const after = await view.client.call("history", { workspace: ws.id, page });
  assert.equal(after.length, 2, "restoring keeps the replaced content as a version");
  await assert.rejects(view.client.call("versionState", { workspace: ws.id, page, version: "../../etc" }));
  h.release();
});

test("a restart keeps workspaces, pages and the device id", async () => {
  const first = device();
  const [ws] = await booted(first);
  const view = first.open("v1");
  await view.client.ready;
  const { page } = await view.client.call("createPage", { workspace: ws.id, parent: "", kind: "page", title: "Survivor" });
  const h = await opened(view.client, ws.id, `p:${page}`);
  h.doc.getXmlFragment("blocks").insert(0, [new Y.XmlText("still here after a restart")]);
  const mainDoc = await first.notes.spaceStore(ws.id).get(`p-${page}`);
  await until(() => mainDoc.getXmlFragment("blocks").length === 1, 3000, "edit reaches main");
  await first.notes.whenIdle();
  h.release();
  const deviceId = first.notes.deviceId;
  await first.stop();
  const second = device({ dir: first.dir, storage: first.storage });
  const list = await booted(second);
  assert.equal(second.notes.deviceId, deviceId);
  assert.deepEqual(list.map((w) => w.id), [ws.id]);
  await until(async () => {
    await second.notes.whenIdle();
    second.notes.reindexNow();
    return (await second.notes.call("search", { query: "restart" }))[0]?.page === page;
  }, 5000, "index rebuilt from disk");
});

test("a shared workspace syncs two devices through one folder, with presence", async () => {
  const shared = mkdtempSync(join(tmpdir(), "notes-shared-"));
  const alice = device({ sharedRoot: shared, settings: { name: "Alice" } });
  await booted(alice);
  const team = await alice.notes.call("createSharedWorkspace", { name: "Team" });
  assert.equal(team.shared, true);
  const grantDir = alice.files.roots.get(team.folderId);
  assert.ok(existsSync(join(grantDir, "workspace.json")));
  const bob = device({ sharedRoot: shared, settings: { name: "Bob" } });
  await booted(bob);
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", grantDir, "Team"));
  const joined = await bob.notes.call("joinSharedWorkspace", {});
  assert.equal(joined.id, team.id);
  const again = await bob.notes.call("joinSharedWorkspace", {});
  assert.equal(again, null);
  const { page } = await alice.notes.call("createPage", { workspace: team.id, parent: "", kind: "page", title: "Plan" });
  await until(() => model.getPage(bob.notes.treeOf(team.id) ?? new Y.Doc(), page)?.title === "Plan", 5000, "page reaches bob");
  const bobView = bob.open("b1");
  await bobView.client.ready;
  const bobDoc = await opened(bobView.client, team.id, `p:${page}`);
  bobDoc.doc.getXmlFragment("blocks").insert(0, [new Y.XmlText("written by bob")]);
  await until(async () => {
    const doc = await alice.notes.spaceStore(team.id).get(`p-${page}`);
    return model.plainText(model.blocksOf(doc)).includes("written by bob");
  }, 5000, "bob's edit reaches alice");
  await until(() => alice.notes.presence().some((p) => p.name === "Bob" && p.page === page && p.workspace === team.id), 5000, "bob's presence");
  await alice.notes.whenIdle();
  alice.notes.reindexNow();
  assert.equal((await alice.notes.call("search", { query: "bob", workspace: team.id }))[0]?.page, page);
  const ok = await alice.notes.call("shareWorkspace", { workspace: team.id });
  assert.equal(ok.ok, true);
  bobDoc.release();
});

test("presence and the last page follow the page a view shows, not the inline databases it opens", async () => {
  const shared = mkdtempSync(join(tmpdir(), "notes-shared-"));
  const alice = device({ sharedRoot: shared, settings: { name: "Alice" } });
  await booted(alice);
  const team = await alice.notes.call("createSharedWorkspace", { name: "Team" });
  const { page } = await alice.notes.call("createPage", { workspace: team.id, parent: "", kind: "page", title: "Plan" });
  const { page: db } = await alice.notes.call("createPage", { workspace: team.id, parent: page, kind: "database", title: "Tasks" });
  const view = alice.open("a1");
  await view.client.ready;
  view.client.viewing(team.id, page);
  await opened(view.client, team.id, `p:${page}`);
  await opened(view.client, team.id, `p:${db}`);
  await until(() => alice.notes.presence().some((p) => p.name === "Alice") || existsSync(join(alice.files.roots.get(team.folderId), "presence")), 5000, "presence written");
  await alice.notes.whenIdle();
  assert.deepEqual(await alice.notes.resolve("/"), { workspace: team.id, page });
  const bob = device({ sharedRoot: shared, settings: { name: "Bob" } });
  await booted(bob);
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", alice.files.roots.get(team.folderId), "Team"));
  await bob.notes.call("joinSharedWorkspace", {});
  await until(() => bob.notes.presence().some((p) => p.name === "Alice"), 5000, "alice's presence");
  assert.equal(bob.notes.presence().find((p) => p.name === "Alice").page, page);
  view.client.viewing(null, null);
  await until(() => !bob.notes.presence().some((p) => p.name === "Alice"), 5000, "alice left the page");
});

test("export writes the page into a folder the user picks, never over an existing file, and drops the grant", async () => {
  const d = device();
  await booted(d);
  const out = mkdtempSync(join(tmpdir(), "notes-export-"));
  d.folders.pickQueue.push(M.grantFor(d.files, "exportgrant", out, "Desktop"), M.grantFor(d.files, "exportgrant2", out, "Desktop"), null);
  assert.deepEqual(await d.notes.call("exportFile", { name: "Plan: Q3.md", text: "# Plan" }), { folder: "Desktop", name: "Plan- Q3.md" });
  assert.deepEqual(await d.notes.call("exportFile", { name: "Plan: Q3.md", text: "# Plan again" }), { folder: "Desktop", name: "Plan- Q3 2.md" });
  assert.equal(await d.notes.call("exportFile", { name: "x.md", text: "x" }), null);
  assert.deepEqual(readdirSync(out).sort(), ["Plan- Q3 2.md", "Plan- Q3.md"]);
  assert.deepEqual(await d.folders.list(), []);
});

test("sharing a private workspace moves it into a shared folder intact", async () => {
  const d = device();
  const [ws] = await booted(d);
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0];
  const res = await d.notes.call("shareWorkspace", { workspace: ws.id });
  assert.equal(res.ok, true);
  const info = d.notes.workspaces()[0];
  assert.equal(info.id, ws.id);
  assert.equal(info.shared, true);
  const dir = d.files.roots.get(info.folderId);
  assert.ok(existsSync(join(dir, "workspace.json")));
  assert.ok(existsSync(join(dir, "docs/ws")));
  await until(() => d.notes.treeOf(ws.id), 3000, "reopened");
  assert.equal(model.getPage(d.notes.treeOf(ws.id), page.id).title, "Getting Started");
  const doc = await d.notes.spaceStore(ws.id).get(`p-${page.id}`);
  assert.match(model.plainText(model.blocksOf(doc)), /Welcome to Notes/);
  assert.ok(!existsSync(join(d.dir, "data/workspaces", ws.id, "docs/ws", `${d.notes.deviceId}.log`)), "private copy removed");
});

test("names, colours and silent views", async () => {
  const d = device({ viewTimeoutMs: 150, sweepMs: 50 });
  await booted(d);
  const view = d.open("v1");
  await view.client.ready;
  const me = view.client.me();
  assert.equal(me.color, M.colorFor(me.deviceId));
  const meEvents = [];
  view.client.onMe((m) => meEvents.push(m.name));
  d.notes.onSettings({ name: "Grace" });
  await until(() => meEvents.includes("Grace"), 3000, "me broadcast");
  const set = await view.client.call("setMe", { name: "G.", color: "#00aa00" });
  assert.equal(set.name, "G.");
  assert.equal(set.color, "#00aa00");
  assert.equal(d.notes.viewCount(), 1);
  await until(() => d.notes.viewCount() === 0, 3000, "silent view dropped");
});

test("database rows are searchable by their property values, and Tasks is a real database", async () => {
  const d = device();
  const [ws] = await booted(d);
  const tree = d.notes.treeOf(ws.id);
  const tasks = model.childrenOf(tree, "").find((p) => p.title === "Tasks");
  assert.equal(tasks.kind, "database");
  const dbDoc = await d.notes.spaceStore(ws.id).get(`p-${tasks.id}`);
  assert.equal(M.database.isInitialized(dbDoc), true);
  assert.ok(M.database.readSchema(dbDoc).some((p) => p.type === "title"));
  assert.equal(model.childrenOf(tree, tasks.id).length, 3);
  const stage = M.database.addProperty(dbDoc, { type: "select", name: "Stage" });
  const option = M.database.addOption(dbDoc, stage, "Zanzibar");
  const notesProp = M.database.addProperty(dbDoc, { type: "text", name: "Notes" });
  const row = model.childrenOf(tree, tasks.id)[0];
  model.setProp(tree, row.id, stage, option, "x");
  model.setProp(tree, row.id, notesProp, "quixotic remark", "x");
  await until(async () => {
    d.notes.reindexNow();
    const a = await d.notes.call("search", { query: "zanzibar" });
    const b = await d.notes.call("search", { query: "quixotic" });
    return a[0]?.page === row.id && b[0]?.page === row.id;
  }, 3000, "row values indexed");
  M.database.updateOption(dbDoc, stage, option, { name: "Kilimanjaro" });
  await until(async () => {
    d.notes.reindexNow();
    return (await d.notes.call("search", { query: "kilimanjaro" }))[0]?.page === row.id;
  }, 3000, "renamed option reindexed");
});

test("each doc's awareness carries the user, and paths follow window.ardia", async () => {
  const d = device({ settings: { name: "Ada" } });
  const [ws] = await booted(d);
  const one = d.open("v1");
  const two = d.open("v2");
  await Promise.all([one.client.ready, two.client.ready]);
  const page = model.childrenOf(d.notes.treeOf(ws.id), "")[0].id;
  const a = await opened(one.client, ws.id, `p:${page}`);
  assert.equal(a.awareness.getLocalState().user.name, "Ada");
  const b = await opened(two.client, ws.id, `p:${page}`);
  await until(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === "Ada", 3000, "user relayed without the editor");
  d.notes.onSettings({ name: "Ada L." });
  await until(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === "Ada L.", 3000, "renamed user relayed");
  const paths = [];
  one.client.onPath((p) => paths.push(p));
  assert.equal(one.client.path(), "/");
  one.client.navigate("/search?q=x");
  assert.equal(one.client.path(), "/search?q=x");
  one.ardia.moveTo("/Back-0123456789ab");
  assert.deepEqual(paths, ["/search?q=x", "/Back-0123456789ab"]);
  a.release();
  b.release();
});
