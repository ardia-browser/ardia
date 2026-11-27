import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "notes-pshare-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const sharedRoot = options.sharedRoot ?? join(dir, "shared");
  mkdirSync(sharedRoot, { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, sharedRoot, []);
  const storage = new Map();
  const settings = { name: options.name ?? "", searchEverywhere: true };
  const hub = M.pageHub();
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
    openPage: async () => undefined,
    openUrl: async () => undefined,
    store: { debounceMs: 5, rescanMs: 100 },
    log: (level, text) => logs.push(`${level} ${text}`),
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  const pages = [];
  const d = {
    dir,
    files,
    folders,
    storage,
    notes,
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
  return d.notes.workspaces();
}

async function opened(client, workspace, doc) {
  const handle = client.open(workspace, doc);
  await Promise.race([handle.synced, new Promise((_, reject) => setTimeout(() => reject(new Error(`${doc} never synced`)), 5000))]);
  return handle;
}

const text = async (d, ws, page) => model.plainText(model.blocksOf(await d.notes.spaceStore(ws).get(`p-${page}`)));

function write(doc, words) {
  doc.getXmlFragment("blocks").insert(doc.getXmlFragment("blocks").length, [new Y.XmlText(words)]);
}

async function sharedSetup(name = "Alice") {
  const shared = mkdtempSync(join(tmpdir(), "notes-pshare-root-"));
  const alice = device({ sharedRoot: shared, name });
  const [home] = await booted(alice);
  const { page: plan } = await alice.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Trip plan", icon: "✈️" });
  const { page: child } = await alice.notes.call("createPage", { workspace: home.id, parent: plan, kind: "page", title: "Packing" });
  const { page: other } = await alice.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Diary" });
  write(await alice.notes.spaceStore(home.id).get(`p-${plan}`), "flights on friday");
  write(await alice.notes.spaceStore(home.id).get(`p-${child}`), "socks");
  const cover = await alice.notes.access().putFile(home.id, new TextEncoder().encode("cover-bytes"), "cover.png", "image/png");
  const secret = await alice.notes.access().putFile(home.id, new TextEncoder().encode("diary-secret"), "secret.png", "image/png");
  model.updatePage(alice.notes.treeOf(home.id), plan, { cover }, "x");
  model.updatePage(alice.notes.treeOf(home.id), other, { cover: secret }, "x");
  await alice.notes.whenIdle();
  return { shared, alice, home, plan, child, other, cover, secret };
}

test("sharing a page moves it and its subpages into their own folder and leaves a link in place", async () => {
  const { alice, home, plan, child, other, cover, secret } = await sharedSetup();
  const before = model.getPage(alice.notes.treeOf(home.id), plan);
  const res = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  assert.ok(res, "shared");
  assert.equal(res.invited, true, "macOS Collaborate was asked to open");
  const share = res.workspace;
  assert.deepEqual(share.pageShare, { root: plan, home: home.id, location: "icloud", folder: "Trip plan" });
  assert.equal(share.shared, true);
  const dir = alice.files.roots.get(share.folderId);
  const json = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  assert.deepEqual(json, { format: "ardia-notes", version: 1, id: share.id, name: "Trip plan", root: plan });
  assert.deepEqual(alice.folders.shared, [share.folderId]);

  const homeTree = alice.notes.treeOf(home.id);
  const link = model.getPage(homeTree, plan);
  assert.equal(link.sharedIn, share.id);
  assert.equal(link.parent, before.parent);
  assert.equal(link.order, before.order);
  assert.equal(model.getPage(homeTree, child).deleted, true, "the subpage left the private tree");
  assert.equal(model.getPage(homeTree, other).deleted, false, "other pages stay private");

  const shareTree = alice.notes.treeOf(share.id);
  assert.equal(model.getPage(shareTree, plan).parent, "");
  assert.equal(model.getPage(shareTree, plan).sharedIn, "");
  assert.equal(model.getPage(shareTree, child).parent, plan);
  assert.equal(model.childrenOf(shareTree, "").length, 1);
  assert.match(await text(alice, share.id, plan), /flights on friday/);
  assert.match(await text(alice, share.id, child), /socks/);
  const store = alice.notes.spaceStore(share.id);
  assert.ok(await store.getFile(cover.slice(5)), "the page's attachment came along");
  assert.equal(await store.getFile(secret.slice(5)), null, "another page's attachment did not");

  assert.deepEqual(await alice.notes.resolve(`/Trip-plan-${plan}`), { workspace: share.id, page: plan });
  await alice.notes.whenIdle();
  alice.notes.reindexNow();
  const hits = await alice.notes.call("search", { query: "trip plan" });
  assert.deepEqual(hits.filter((h) => h.page === plan).map((h) => h.workspace), [share.id], "found once, in the share");
  assert.equal((await alice.notes.call("counts", {})).page_share_creates, 1);

  await assert.rejects(alice.notes.call("sharePage", { workspace: home.id, page: plan }), /already shared/);
  await assert.rejects(alice.notes.call("duplicatePage", { workspace: share.id, page: plan }), /Duplicate the pages inside/);
});

test("edits made through the private tree land in the shared copy, and subpages belong to the share", async () => {
  const { alice, home, plan, other } = await sharedSetup();
  const view = alice.open("a1");
  await view.client.ready;
  const stale = await opened(view.client, home.id, `p:${plan}`);
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  write(stale.doc, " and hotel on saturday");
  await until(async () => (await text(alice, share.id, plan)).includes("hotel on saturday"), 5000, "the old view's edit reaches the share");

  const { page: sub } = await alice.notes.call("createPage", { workspace: home.id, parent: plan, kind: "page", title: "Budget" });
  assert.equal(model.getPage(alice.notes.treeOf(share.id), sub)?.parent, plan, "a subpage made from the private tree goes into the share");
  assert.equal(model.getPage(alice.notes.treeOf(home.id), sub), null);
  const { page: top } = await alice.notes.call("createPage", { workspace: share.id, parent: "", kind: "page", title: "Loose" });
  assert.equal(model.getPage(alice.notes.treeOf(share.id), top).parent, plan, "nothing lands beside the shared page");

  const moved = await alice.notes.call("movePage", { workspace: home.id, page: other, parent: plan });
  assert.deepEqual(moved, { page: other, workspace: share.id });
  assert.equal(model.getPage(alice.notes.treeOf(share.id), other).parent, plan);
  assert.equal(model.getPage(alice.notes.treeOf(home.id), other).deleted, true);
  assert.ok(await alice.notes.spaceStore(share.id).getFile(model.getPage(alice.notes.treeOf(share.id), other).cover.slice(5)), "a page moved in brings its attachments");

  const back = await alice.notes.call("movePage", { workspace: share.id, page: other, parent: "", toWorkspace: home.id });
  assert.deepEqual(back, { page: other, workspace: home.id });
  assert.equal(model.getPage(alice.notes.treeOf(home.id), other).deleted, false);
  assert.equal(model.getPage(alice.notes.treeOf(share.id), other).deleted, true);

  const { page: diary } = await alice.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Elsewhere" });
  const reorder = await alice.notes.call("movePage", { workspace: share.id, page: plan, parent: diary });
  assert.deepEqual(reorder, { page: plan, workspace: home.id }, "moving the shared page moves its link");
  assert.equal(model.getPage(alice.notes.treeOf(home.id), plan).parent, diary);
  const team = await alice.notes.call("createWorkspace", { name: "Other" });
  await assert.rejects(alice.notes.call("movePage", { workspace: home.id, page: diary, parent: "", toWorkspace: team.id }), /Stop sharing it first/);
  stale.release();
});

test("a second device joins the page share and sees only that page, and both edit it", async () => {
  const { shared, alice, home, plan, child } = await sharedSetup();
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  const bob = device({ sharedRoot: shared, name: "Bob" });
  await booted(bob);
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", alice.files.roots.get(share.folderId), "Trip plan"));
  const joined = await bob.notes.call("joinSharedWorkspace", {});
  assert.equal(joined.id, share.id);
  assert.deepEqual(joined.pageShare, { root: plan, home: null, location: "icloud", folder: "Trip plan" });
  await until(() => model.getPage(bob.notes.treeOf(share.id) ?? new Y.Doc(), child), 5000, "the subpage reaches bob");
  assert.match(await text(bob, share.id, plan), /flights on friday/);
  assert.equal((await bob.notes.call("counts", {})).page_share_joins, 1);
  await assert.rejects(bob.notes.call("archivePage", { workspace: share.id, page: plan }), /leave it instead/);
  await assert.rejects(bob.notes.call("movePage", { workspace: share.id, page: plan, parent: "" }), /stays at the top/);
  assert.equal(await bob.notes.call("stopSharingPage", { workspace: share.id }).catch((e) => e.message), "The private workspace it came from isn't on this Mac, so leave it instead.");

  const { page: bobs } = await bob.notes.call("createPage", { workspace: share.id, parent: plan, kind: "page", title: "Bob's list" });
  write(await bob.notes.spaceStore(share.id).get(`p-${bobs}`), "snacks from bob");
  await until(() => model.getPage(alice.notes.treeOf(share.id), bobs)?.title === "Bob's list", 5000, "bob's subpage reaches alice");
  await until(async () => (await text(alice, share.id, bobs)).includes("snacks from bob"), 5000, "bob's text reaches alice");

  const view = alice.open("a1");
  await view.client.ready;
  const page = await opened(view.client, share.id, `p:${plan}`);
  write(page.doc, " alice was here");
  await until(async () => (await text(bob, share.id, plan)).includes("alice was here"), 5000, "alice's edit reaches bob");
  page.release();
});

test("stopping a page share brings everything back into place, then leaves the folder", async () => {
  const { shared, alice, home, plan, child } = await sharedSetup();
  const before = model.getPage(alice.notes.treeOf(home.id), plan);
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  const bob = device({ sharedRoot: shared, name: "Bob" });
  await booted(bob);
  bob.folders.pickQueue.push(M.grantFor(bob.files, "bobgrant", alice.files.roots.get(share.folderId), "Trip plan"));
  await bob.notes.call("joinSharedWorkspace", {});
  await until(() => model.getPage(bob.notes.treeOf(share.id) ?? new Y.Doc(), plan), 5000, "bob has it");
  const { page: bobs } = await bob.notes.call("createPage", { workspace: share.id, parent: child, kind: "page", title: "Bob's page" });
  write(await bob.notes.spaceStore(share.id).get(`p-${plan}`), " bob edit");
  const pic = await bob.notes.access().putFile(share.id, new TextEncoder().encode("bob-picture"), "pic.png", "image/png");
  model.updatePage(bob.notes.treeOf(share.id), bobs, { cover: pic }, "bob");
  await bob.notes.whenIdle();
  await until(async () => model.getPage(alice.notes.treeOf(share.id), bobs)?.cover === pic && (await text(alice, share.id, plan)).includes("bob edit"), 8000, "bob's work reaches alice");
  await until(async () => !!(await alice.notes.spaceStore(share.id).getFile(pic.slice(5))), 5000, "bob's file reaches alice");

  const view = alice.open("a1");
  await view.client.ready;
  const live = await opened(view.client, share.id, `p:${plan}`);
  const res = await alice.notes.call("stopSharingPage", { workspace: share.id });
  assert.deepEqual(res, { workspace: home.id, page: plan, stopped: true, missing: [] });
  assert.ok(!alice.notes.workspaces().some((w) => w.id === share.id), "the share is gone from this Mac");
  assert.deepEqual(await alice.folders.list(), [], "the folder grant is forgotten");
  assert.ok(existsSync(join(alice.files.roots.get(share.folderId), "workspace.json")), "the folder stays for the others");

  const tree = alice.notes.treeOf(home.id);
  const root = model.getPage(tree, plan);
  assert.equal(root.sharedIn, "");
  assert.equal(root.deleted, false);
  assert.equal(root.parent, before.parent);
  assert.equal(root.order, before.order);
  assert.equal(root.title, "Trip plan");
  assert.equal(model.getPage(tree, child).deleted, false);
  assert.equal(model.getPage(tree, child).parent, plan);
  assert.equal(model.getPage(tree, bobs).parent, child, "pages others made come back too");
  assert.match(await text(alice, home.id, plan), /flights on friday.*bob edit/s);
  assert.ok(await alice.notes.spaceStore(home.id).getFile(pic.slice(5)), "and their attachments");
  assert.deepEqual(await alice.notes.resolve(`/x-${plan}`), { workspace: home.id, page: plan });
  assert.equal((await alice.notes.call("counts", {})).page_share_stops, 1);

  write(live.doc, " typed during the switch");
  await until(async () => (await text(alice, home.id, plan)).includes("typed during the switch"), 5000, "an edit to the old share id lands in the private page");
  live.release();
});

test("stopping refuses when the private copy has changes the shared one lacks", async () => {
  const { alice, home, plan } = await sharedSetup();
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  write(await alice.notes.spaceStore(home.id).get(`p-${plan}`), " stray private edit");
  await assert.rejects(alice.notes.call("stopSharingPage", { workspace: share.id }), /changes the shared one doesn't/);
  assert.ok(alice.notes.workspaces().some((w) => w.id === share.id), "still shared");
  assert.equal(model.getPage(alice.notes.treeOf(home.id), plan).sharedIn, share.id);
  assert.equal((await alice.notes.call("counts", {})).page_share_failures, 1);
});

test("what can't be shared on its own is refused, and a cancelled folder leaves nothing behind", async () => {
  const { alice, home, plan } = await sharedSetup();
  const tree = alice.notes.treeOf(home.id);
  const db = model.childrenOf(tree, "").find((p) => p.kind === "database");
  const row = model.childrenOf(tree, db.id)[0];
  await assert.rejects(alice.notes.call("sharePage", { workspace: home.id, page: row.id }), /database this row belongs to/);
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  await assert.rejects(alice.notes.call("sharePage", { workspace: share.id, page: plan }), /can already see/);
  alice.folders.create = async () => null;
  const { page: lone } = await alice.notes.call("createPage", { workspace: home.id, parent: "", kind: "page", title: "Lone" });
  assert.equal(await alice.notes.call("sharePage", { workspace: home.id, page: lone }), null);
  assert.equal(model.getPage(tree, lone).sharedIn, "");
  assert.equal(alice.notes.workspaces().filter((w) => w.pageShare).length, 1);
});

test("a hostile workspace.json in a shared folder is read only within its limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-pshare-hostile-"));
  const d = device();
  await booted(d);
  const cases = [
    ["huge", JSON.stringify({ format: "ardia-notes", version: 1, id: "abcdefabcdef", name: "x".repeat(10_000), root: "aaaaaaaaaaaa" }), /other files in it/],
    ["badroot", JSON.stringify({ format: "ardia-notes", version: 1, id: "abcdefabcdee", name: "Bad‮root", root: "../../etc" }), null],
    ["proto", '{"__proto__":{"root":"aaaaaaaaaaaa"},"format":"ardia-notes","id":"abcdefabcded","name":"P"}', null],
  ];
  for (const [name, body, rejects] of cases) {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "workspace.json"), body);
    d.folders.pickQueue.push(M.grantFor(d.files, `g-${name}`, folder, name));
    if (rejects) {
      await assert.rejects(d.notes.call("joinSharedWorkspace", {}), rejects);
      continue;
    }
    const joined = await d.notes.call("joinSharedWorkspace", {});
    assert.equal(joined.pageShare, undefined, `${name}: not taken as a page share`);
    assert.ok(!/[‪-‮]/.test(joined.name), `${name}: bidi controls dropped`);
  }
});

test("a page someone adds to the share can't take over a private page when sharing stops", async () => {
  const { alice, home, plan, other } = await sharedSetup();
  const { workspace: share } = await alice.notes.call("sharePage", { workspace: home.id, page: plan });
  const shareTree = alice.notes.treeOf(share.id);
  model.createPage(shareTree, { id: other, parent: plan, kind: "page", title: "Hijack", by: "mallory" });
  await assert.rejects(alice.notes.call("stopSharingPage", { workspace: share.id }), /same id as one of your private pages/);
  assert.equal(model.getPage(alice.notes.treeOf(home.id), other).title, "Diary");
  assert.equal(model.getPage(alice.notes.treeOf(home.id), plan).sharedIn, share.id);
});
