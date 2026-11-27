import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { ensureRoots } = await import("../bookmarks/bookmarks.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 11, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 11); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 11);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  useBrowser.setState((s) => ({ bookmarks: ensureRoots(s.bookmarks, "")[0] }));
  return S().createWindow({ url: "https://a.example/" });
}

const download = (fields) => ({ url: "https://files.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "downloading", paused: false, received: 10, total: 100, speed: 5, mimeType: "application/zip", profile: "", ...fields });

test("bookmarks: add, folder, move, rename, search, remove", async () => {
  await setup();
  const tree = await ok("bookmarks.tree");
  assert.equal(tree.bar.kind, "folder");
  const link = await ok("bookmarks.add", { url: "https://docs.example/", title: "Docs" });
  assert.equal(link.parent, tree.bar.id);
  const folder = await ok("bookmarks.addFolder", { title: "Work", parent: tree.other.id });
  await ok("bookmarks.move", { ids: [link.id], parent: folder.id });
  assert.equal(S().bookmarks.nodes[link.id].parentId, folder.id);
  assert.equal((await ok("bookmarks.update", { id: link.id, title: "Manual" })).title, "Manual");
  assert.equal((await call("bookmarks.update", { id: folder.id, url: "https://x.example/" })).error.code, "bad_request");
  assert.equal((await call("bookmarks.move", { ids: [folder.id], parent: folder.id })).error.code, "bad_request");
  assert.equal((await call("bookmarks.add", { url: "javascript:alert(1)" })).error.code, "refused");
  const found = await ok("bookmarks.search", { query: "manual" });
  assert.deepEqual(found.items.map((n) => n.id), [link.id]);
  assert.equal(found.total, 1);
  assert.equal((await ok("bookmarks.get", { id: folder.id })).children.length, 1);
  assert.equal((await call("bookmarks.remove", { ids: [tree.bar.id] })).error.code, "refused");
  assert.equal((await ok("bookmarks.remove", { ids: [folder.id] })).removed, 1);
  assert.equal(S().bookmarks.nodes[link.id], undefined);
});

test("history: search pages, remove a page, clear", async () => {
  await setup();
  const db = stub.chromeHistory("");
  db.clear();
  db.set("https://one.example/", { title: "One", visits: [1000, 2000] });
  db.set("https://two.example/", { title: "Two", visits: [3000] });
  const all = await ok("history.search", { limit: 1 });
  assert.equal(all.total, null, "the engine was asked for one page, so it didn't count the rest");
  assert.equal((await ok("history.search", {})).total, 2);
  assert.equal(all.items[0].url, "https://two.example/");
  assert.equal(all.nextOffset, 1);
  assert.deepEqual((await ok("history.search", { query: "one" })).items.map((h) => h.url), ["https://one.example/"]);
  assert.deepEqual((await ok("history.search", { until: 2500 })).items.map((h) => h.url), ["https://one.example/"]);
  await ok("history.remove", { urls: ["https://one.example/"] });
  await tick();
  assert.equal(db.has("https://one.example/"), false);
  const before = stub.engineCalls.length;
  await ok("history.clear", { since: 2500 });
  assert.ok(stub.engineCalls.slice(before).some((c) => c.domain === "profiles" && c.verb === "clearBrowsingData"));
});

test("downloads: list, pause, cancel, refuse what doesn't fit, remove, settings", async () => {
  await setup();
  S().upsertDownload(download({ id: "d1" }));
  S().upsertDownload(download({ id: "d2", state: "finished", received: 100 }));
  S().upsertDownload(download({ id: "p1", offTheRecord: true }));
  const list = await ok("downloads.list");
  assert.deepEqual(list.items.map((d) => d.id).sort(), ["d1", "d2"]);
  assert.deepEqual((await ok("downloads.list", { state: "finished" })).items.map((d) => d.id), ["d2"]);
  await ok("downloads.pause", { id: "d1" });
  assert.equal((await call("downloads.resume", { id: "d1" })).error.code, "refused");
  assert.equal((await call("downloads.pause", { id: "p1" })).error.code, "no_window");
  assert.equal((await call("downloads.remove", { id: "d1" })).error.code, "refused");
  await ok("downloads.cancel", { id: "d1" });
  assert.ok(stub.cancelledDownloads.includes("d1"));
  assert.equal((await call("downloads.keep", { id: "d2" })).error.code, "refused");
  await ok("downloads.remove", { id: "d2" });
  assert.equal(S().downloads.some((d) => d.id === "d2"), false);
  assert.deepEqual(await ok("downloads.settings"), { folder: "", askWhereToSave: false, managed: false });
  assert.equal((await call("downloads.setSettings", { folder: "relative" })).error.code, "bad_request");
  await ok("downloads.setSettings", { askWhereToSave: true });
});

test("settings: read, schema, set what config.json takes, refuse control itself, reset", async () => {
  await setup();
  const all = await ok("settings.get");
  assert.equal(all.cliControl, true);
  assert.deepEqual(Object.keys(await ok("settings.get", { keys: ["tabLayout"] })), ["tabLayout"]);
  const schema = await ok("settings.schema");
  assert.equal(schema.find((s) => s.key === "tabLayout").writable, true);
  assert.equal(schema.find((s) => s.key === "cliControl").writable, false);
  assert.equal(schema.find((s) => s.key === "showCliPill").writable, false);
  const set = await ok("settings.set", { values: { tabLayout: "top", showUnreadCounts: true } });
  assert.deepEqual(set.changed.sort(), ["showUnreadCounts", "tabLayout"]);
  assert.equal(S().settings.tabLayout, "top");
  const bad = await call("settings.set", { values: { tabLayout: "diagonal", showUnreadCounts: false } });
  assert.equal(bad.error.code, "bad_request");
  assert.equal(S().settings.showUnreadCounts, true);
  assert.equal((await call("settings.set", { values: { cliControl: false } })).error.code, "refused");
  assert.equal((await call("settings.set", { values: { showCliPill: false } })).error.code, "refused");
  assert.equal((await call("settings.reset", { keys: ["showCliPill"] })).error.code, "refused");
  assert.match((await call("settings.set", { values: { defaultProfileId: "x" } })).error.message, /profiles\.setDefault/);
  assert.equal(S().settings.cliControl, true);
  assert.equal(S().settings.showCliPill, true);
  await ok("settings.reset", { keys: ["tabLayout"] });
  assert.equal(S().settings.tabLayout, "sidebar");
});

test("search engines: add, default, update, remove; built-ins stay", async () => {
  await setup();
  const engines = await ok("search.engines");
  assert.ok(engines.some((e) => e.default));
  const added = await ok("search.add", { name: "Docs", keyword: "docs", url: "https://docs.example/?q=%s" });
  assert.equal(added.custom, true);
  assert.equal((await ok("search.setDefault", { id: added.id })).default, true);
  assert.equal((await ok("search.update", { id: added.id, name: "Manual" })).name, "Manual");
  assert.equal((await call("search.remove", { id: engines[0].id })).error.code, "refused");
  await ok("search.remove", { id: added.id });
  assert.equal(S().settings.searchEngine === added.id, false);
  assert.equal((await call("search.add", { name: "", keyword: "x", url: "https://x.example/%s" })).error.code, "bad_request");
});
