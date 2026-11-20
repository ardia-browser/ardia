import assert from "node:assert/strict";
import { test } from "node:test";
const { S, socketClient, controlOn, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { useDownloadProgress } = await import("../downloads/progress.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { tabLayoutOf } = await import("../browser/model.ts");
const { TREE_MAX_ITEMS } = await import("./socketLibrary.ts");
const stub = await import("../../test-native/index.ts");

const { call, ok } = socketClient(22);

async function withBookmarks() {
  const opened = await freshWindow();
  useBrowser.setState({ bookmarksReady: { "": true } });
  return opened;
}

test("sites.clearData takes a site, clears the whole site, and refuses the old origin form", async () => {
  await freshWindow();
  stub.clearedSiteData.length = 0;
  assert.equal((await call("sites.clearData", { origin: "https://mail.example.com" })).error?.code, "bad_request");
  for (const bad of ["https://example.com", "example.com/path", "example.com:8443", "nodots"]) assert.equal((await call("sites.clearData", { site: bad })).error?.code, "bad_request", bad);
  const cleared = await ok("sites.clearData", { site: "Example.COM" });
  assert.equal(cleared.site, "example.com");
  assert.deepEqual(stub.clearedSiteData.map((c) => c.origin), ["https://example.com"]);
});

test("windows.close asks first when the user set Ardia to, and keeps the last window to reopen", async () => {
  const { windowId } = await freshWindow();
  const other = S().createWindow({ url: "https://b.example/" });
  S().newTab(other, { url: "https://c.example/", background: true });
  S().newTab(other, { url: "https://d.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  const refused = await call("windows.close", { window: other });
  assert.equal(refused.error?.code, "refused", "the stubbed dialog says Cancel");
  assert.ok(S().windows[other]);
  S().updateSettings({ warnBeforeClosingWindow: false });
  await ok("windows.close", { window: other });
  for (let i = 0; i < 50 && S().windows[other]; i++) await new Promise((r) => setImmediate(r));
  assert.equal(S().windows[other], undefined);
  await ok("windows.close", { window: windowId });
  for (let i = 0; i < 50 && S().windows[windowId]; i++) await new Promise((r) => setImmediate(r));
  assert.equal(S().windows[windowId], undefined);
  assert.equal(S().closedWindows.at(-1)?.lastWindow ?? S().closedWindows[0]?.lastWindow, true, "the last window is kept to reopen");
});

test("bookmarks.move of a folder with its own child reports what the store did", async () => {
  await withBookmarks();
  const outer = await ok("bookmarks.addFolder", { title: "Outer" });
  const inner = await ok("bookmarks.addFolder", { title: "Inner", parent: outer.id });
  const target = await ok("bookmarks.addFolder", { title: "Target" });
  const moved = await ok("bookmarks.move", { ids: [outer.id, inner.id], parent: target.id });
  assert.deepEqual(moved.children.map((c) => c.id), [outer.id]);
  assert.equal(S().bookmarks.nodes[inner.id].parentId, outer.id);
});

test("bookmarks: a profile that doesn't hold the folder or parent is refused", async () => {
  await withBookmarks();
  const work = await ok("profiles.create", { name: "Work" });
  useBrowser.setState({ bookmarksReady: { ...S().bookmarksReady, [work.id]: true } });
  S().addBookmarkFolder({ profileId: work.id, title: "Seed" });
  assert.ok(bookmarkRoots(S(), work.id));
  const mine = await ok("bookmarks.addFolder", { title: "Mine" });
  assert.equal((await call("bookmarks.tree", { profile: work.id, folder: mine.id })).error?.code, "bad_request");
  assert.equal((await call("bookmarks.add", { profile: work.id, parent: mine.id, url: "https://x.example/" })).error?.code, "bad_request");
  assert.equal((await call("bookmarks.addFolder", { profile: work.id, parent: mine.id, title: "x" })).error?.code, "bad_request");
  assert.equal((await ok("bookmarks.add", { profile: S().settings.defaultProfileId, parent: mine.id, url: "https://y.example/" })).parent, mine.id);
});

test("bookmarks.tree stops at its item budget and says it's truncated", async () => {
  await withBookmarks();
  const folder = await ok("bookmarks.addFolder", { title: "Lots" });
  for (let i = 0; i < TREE_MAX_ITEMS + 5; i++) S().addBookmark({ profileId: S().settings.defaultProfileId, url: `https://b${i}.example/`, title: `b${i}`, parentId: folder.id });
  const tree = await ok("bookmarks.tree");
  assert.equal(tree.truncated, true);
  assert.equal(typeof tree.bar.children.find((c) => c.id === folder.id).children, "number");
  const small = await ok("bookmarks.tree", { depth: 1 });
  assert.equal(small.truncated, false);
  const found = await ok("bookmarks.search", { query: "b1", limit: 2 });
  assert.equal(found.items.length, 2);
  assert.ok(found.total > 2);
});

test("history.search asks the engine for only what the page needs", async () => {
  await freshWindow();
  stub.chromeHistory("").clear();
  for (let i = 0; i < 30; i++) stub.chromeVisit("", `https://h${i}.example/`, `Page ${i}`, 1_000_000 + i);
  stub.historyQueries.length = 0;
  const first = await ok("history.search", { limit: 1 });
  assert.deepEqual(first.items.map((h) => h.url), ["https://h29.example/"]);
  assert.equal(first.nextOffset, 1);
  assert.ok(stub.historyQueries.every((q) => q.maxUrls <= 2 && q.maxVisits === 1), JSON.stringify(stub.historyQueries));
  const searched = await ok("history.search", { query: "page 1", limit: 3 });
  assert.equal(searched.total, 11);
  assert.equal(searched.truncated, false);
});

test("closed.list and closed.clear act on the same window by default, and clearing with no window open is an error", async () => {
  const { windowId } = await freshWindow();
  const b = S().newTab(windowId, { url: "https://b.example/", background: true });
  S().closeTabs([b]);
  const listed = await ok("closed.list");
  assert.ok(listed.length >= 1);
  assert.equal((await ok("closed.clear")).cleared, listed.length);
  assert.equal((await ok("closed.list")).length, 0);
  S().hydrate({});
  await controlOn();
  assert.equal((await call("closed.clear")).error?.code, "no_window");
  assert.equal((await call("closed.list")).error?.code, "no_window");
});

test("settings: resetting shortcuts drops custom ones, and tabLayout moves open windows as Settings does", async () => {
  const { windowId } = await freshWindow();
  S().updateSettings({ shortcuts: { newTab: ["y", "cmd"] } });
  await ok("settings.reset", { keys: ["shortcuts"] });
  assert.deepEqual(S().settings.shortcuts, {});
  const was = tabLayoutOf(S(), windowId);
  const next = was === "top" ? "sidebar" : "top";
  await ok("settings.set", { values: { tabLayout: next } });
  assert.equal(tabLayoutOf(S(), windowId), next);
});

test("search: an extension's engine is the default reported, and setDefault is refused while it controls it", async () => {
  await freshWindow();
  const ddg = { profile: "", extensionId: "dcielhccnenaljfdmekhnepaeenphgjp", extensionName: "Search Fixture", name: "DDG Fixture", keyword: "ddgfix", url: "https://duckduckgo.com/?q=%s", isDefault: true };
  S().updateSettings({ searchEngine: "bing", extensionSearchEngines: [ddg] });
  const engines = await ok("search.engines");
  assert.deepEqual(engines.filter((e) => e.default).map((e) => e.id), [`extension:${ddg.extensionId}`]);
  assert.equal(engines.find((e) => e.default).controlledBy, ddg.extensionId);
  assert.equal((await call("search.setDefault", { id: "google" })).error?.code, "refused");
  assert.equal((await call("settings.set", { values: { searchEngine: "google" } })).error?.code, "refused");
  assert.equal(S().settings.searchEngine, "bing");
  S().updateSettings({ extensionSearchEngines: [] });
  assert.equal((await ok("search.setDefault", { id: "google" })).default, true);
});

test("downloads.list shows live progress and pages like history.search", async () => {
  await freshWindow();
  const row = (id, state) => ({ id, url: `https://dl.example/${id}`, filename: `${id}.zip`, path: `/tmp/${id}.zip`, state, paused: false, received: 0, total: 0, speed: 0, mimeType: "application/zip", profile: "", startTime: 1 });
  useBrowser.setState({ downloads: [row("d1", "downloading"), row("d2", "finished"), row("d3", "finished")] });
  useDownloadProgress.setState({ d1: { received: 50, total: 100, speed: 7 } });
  const first = await ok("downloads.list", { limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual([first.items[0].received, first.items[0].total, first.items[0].speed], [50, 100, 7]);
  assert.equal((await ok("downloads.list", { offset: 2 })).items[0].id, "d3");
});

test("naming tabLayout moves windows that override it, even when the stored value already matches", async () => {
  const { windowId } = await freshWindow();
  const overrideTop = () => useBrowser.setState((s) => ({ windows: { ...s.windows, [windowId]: { ...s.windows[windowId], tabLayout: "top" } } }));
  assert.equal(S().settings.tabLayout, "sidebar");
  overrideTop();
  assert.equal(tabLayoutOf(S(), windowId), "top");
  await ok("settings.set", { values: { tabLayout: "sidebar" } });
  assert.equal(tabLayoutOf(S(), windowId), "sidebar", "settings.set moved the window back");
  overrideTop();
  await ok("settings.reset", { keys: ["tabLayout"] });
  assert.equal(tabLayoutOf(S(), windowId), "sidebar", "settings.reset moved the window back");
});
