import assert from "node:assert/strict";
import { test } from "node:test";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { applyResult } = await import("./apply.ts");
const { bookmarksCurrent, reloadBookmarks, startBookmarks } = await import("../bookmarks/engineSync.ts");
const { useProfileLoading } = await import("../profiles/profileLoading.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

function chromeBar(profile = "") {
  const db = stub.chromeBookmarks(profile);
  const walk = (id) => {
    const n = db.get(id);
    return n.k === "u" ? n.u : { [n.t]: n.children.map(walk) };
  };
  return walk("bar")["Bookmarks Bar"];
}

const result = (bar) => ({
  browserId: "dia",
  profileId: "Default",
  bookmarks: { type: "folder", title: "", children: [{ type: "folder", title: "Bookmarks bar", role: "toolbar", children: bar }] },
  history: [],
  historyCount: 0,
  tabs: [],
  tabGroups: [],
  credentials: [],
  cookieCount: 0,
  addressCount: 0,
  cardCount: 0,
  spaces: [],
  favorites: [],
  favicons: [],
  failed: [],
  warnings: [],
});

test("an import into a profile not opened since launch reads its bookmarks from Chrome first, so it neither doubles one Chrome has nor skips one only a stale cache showed", async () => {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  const a = "0f0f0f0f-0000-4000-8000-00000000a001";
  const b = "0f0f0f0f-0000-4000-8000-00000000b001";
  stub.chromeBookmarkEdit("", [{ op: "add", id: a, k: "u", t: "A", u: "https://a.example/", a: 1, parent: "bar" }]);
  const node = (id, parentId, x) => ({ id, parentId, addedAt: 1, ...x });
  stub.docs.set("bookmarks-cache.json", JSON.stringify({ version: 1, trees: { "": [
    node("bar@default", null, { kind: "folder", title: "Bookmarks Bar", children: [b] }),
    node("other@default", null, { kind: "folder", title: "Other Bookmarks", children: [] }),
    node(b, "bar@default", { kind: "url", title: "B", url: "https://b.example/", favicon: null }),
  ] } }));
  useProfileLoading.setState({ deferred: true, opened: {}, unloaded: {} });
  const stop = startBookmarks();
  try {
    await settle();
    assert.ok(!stub.chromeBookmarks("").has(b), "B was deleted in Chrome since the cache was written");
    const failed = [];
    const counts = await applyResult("default", result([{ type: "url", title: "A", url: "https://a.example/" }, { type: "url", title: "B", url: "https://b.example/" }]), "Dia", ["bookmarks"], (k) => failed.push(k));
    assert.deepEqual(failed, []);
    assert.equal(counts.bookmarks, 1, "only B is new");
    await reloadBookmarks();
    await settle();
    assert.deepEqual(chromeBar(), ["https://a.example/", { "Imported from Dia": ["https://b.example/"] }]);
  } finally {
    stop();
    useProfileLoading.setState({ deferred: false, opened: {}, unloaded: {} });
  }
});

test("a profile whose bookmarks never load from Chrome isn't reported as current, so the import marks bookmarks failed instead of guessing", async () => {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  stub.bookmarkModel.treeHangs = true;
  useProfileLoading.setState({ deferred: true, opened: {}, unloaded: {} });
  const stop = startBookmarks();
  try {
    assert.equal(await bookmarksCurrent("", 50), false);
    assert.ok(useProfileLoading.getState().opened[""], "asking opens the profile so its bookmarks can load");
  } finally {
    stop();
    stub.bookmarkModel.treeHangs = false;
    useProfileLoading.setState({ deferred: false, opened: {}, unloaded: {} });
  }
  assert.equal(await bookmarksCurrent("", 50), true, "with bookmark sync stopped there is nothing to wait for");
});
