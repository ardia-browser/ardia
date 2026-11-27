import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { liveOf: live } = await import("./tabLive.ts");
const { canGoBack, canGoForward, goBack, goForward, historyItems, goToHistoryItem } = await import("./navigation.ts");
const { routeAppPage } = await import("./appPageHistory.ts");
const { appHistoryFromDisk, pushedEntry, MAX_APP_HISTORY } = await import("./appHistory.ts");
const { tabDestination } = await import("../pages/urls.ts");
const { sessionFromSaved } = await import("../session/savedSession.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const HISTORY = "ardia://history";
const BOOKMARKS = "ardia://bookmarks";
const DOWNLOADS = "ardia://downloads";

function webTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const id = S().windows[w].tabIds[0];
  S().updateTab(id, { url: "https://a.com/", title: "A" });
  return { w, id };
}

const at = (id) => tabDestination(S().tabs[id]);
const h = (id) => S().tabs[id].appHistory;
const urls = (id) => h(id).entries.map((e) => e.url);

test("web page, then two app pages: back walks them and lands on the web page with its saved history; forward comes back", () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY]);
  assert.deepEqual(h(id).kept, { index: 0, key: id }, "the web page's own history is kept under the tab's restore key");
  S().navigate(id, BOOKMARKS);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, BOOKMARKS]);
  assert.equal(h(id).index, 2);
  assert.equal(canGoBack(id, live(id)), true);
  assert.equal(canGoForward(id, live(id)), false);

  goBack(id);
  assert.equal(at(id), HISTORY);
  assert.equal(h(id).index, 1);
  assert.equal(canGoForward(id, live(id)), true);
  goBack(id);
  const tab = S().tabs[id];
  assert.equal(tab.url, "https://a.com/");
  assert.deepEqual(tab.page, { kind: "adopted", adopt: `restore:${id}`, nav: null }, "the web view comes back from the tab's saved history");
  assert.equal(h(id).index, 0);
  assert.equal(h(id).kept, undefined, "the saved history is taken once");

  goForward(id);
  assert.equal(at(id), HISTORY);
  goForward(id);
  assert.equal(at(id), BOOKMARKS);
  assert.equal(canGoForward(id, live(id)), false);
});

test("a new navigation drops the forward entries; replace swaps the current one", () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  S().navigate(id, BOOKMARKS);
  goBack(id);
  S().navigate(id, DOWNLOADS);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, DOWNLOADS]);
  assert.equal(routeAppPage(id, "ardia://history?q=x", true), true);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, "ardia://history?q=x"]);
  assert.equal(at(id), "ardia://history?q=x");
  assert.equal(routeAppPage(id, "ardia://history?q=y", false), true);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, "ardia://history?q=x", "ardia://history?q=y"]);
  assert.equal(routeAppPage(id, "ardia://history?q=y", false), false, "the address already shown isn't pushed again");
});

test("leaving an app page for a typed web address pushes it; back returns to the app page", () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  S().navigate(id, "https://b.com/");
  S().updateTab(id, { url: "https://b.com/", title: "B" });
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, "https://b.com/"]);
  assert.equal(canGoBack(id, live(id)), true);
  goBack(id);
  assert.equal(at(id), HISTORY);
  assert.deepEqual(h(id).kept, { index: 2, key: id }, "b.com's web view is the one kept now");
  goForward(id);
  assert.equal(at(id), "https://b.com/");
  assert.equal(S().tabs[id].page.kind, "adopted");
  goBack(id);
  goBack(id);
  assert.equal(at(id), "https://a.com/");
  assert.equal(S().tabs[id].page.kind, "loaded", "a.com's saved web view was replaced by b.com's, so it loads fresh");
});

test("in a web entry the web view's own back comes first, and a link there drops the app entries ahead", () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  goBack(id);
  S().updateTab(id, { url: "https://a.com/" });
  S().updateTab(id, { url: "https://a.com/2", page: { kind: "loaded", nav: { url: "https://a.com/2", seq: 99 } } }, { canGoBack: true });
  assert.deepEqual(urls(id), ["https://a.com/2", HISTORY], "a traversal's first change keeps the entries ahead");
  S().updateTab(id, { url: "https://a.com/3", page: { kind: "loaded", nav: { url: "https://a.com/3", seq: 100 } } }, { canGoBack: true });
  assert.deepEqual(urls(id), ["https://a.com/3"], "a new page in the web view drops what was ahead");
});

test("a tab that never shows an app page gets no app history", () => {
  const { id } = webTab();
  S().navigate(id, "https://b.com/");
  S().navigate(id, "https://c.com/");
  assert.equal(h(id), undefined);
});

test("the history menu lists app entries after the web view's, and picking one goes there", async () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  S().navigate(id, BOOKMARKS);
  S().updateTab(id, { url: BOOKMARKS, title: "Bookmarks" });
  const back = await historyItems(id, -1);
  assert.deepEqual(back.map((i) => i.url), [HISTORY, "https://a.com/"]);
  assert.deepEqual(back[1].offset, { app: 0 });
  assert.equal(back[1].title, "A");
  await goToHistoryItem(id, back[1]);
  assert.equal(S().tabs[id].url, "https://a.com/");
  const ahead = await historyItems(id, 1);
  assert.deepEqual(ahead.map((i) => i.url), [HISTORY, BOOKMARKS]);
  assert.equal(ahead[1].title, "Bookmarks", "an entry's title follows the tab's while it is shown");
});

test("the app history goes with a closed tab and comes back when it is reopened", () => {
  const { w, id } = webTab();
  S().newTab(w, { url: "https://other.com/" });
  S().navigate(id, HISTORY);
  S().navigate(id, BOOKMARKS);
  S().updateTab(id, { url: BOOKMARKS });
  S().closeTab(id);
  const closed = S().closedTabs.at(-1);
  assert.deepEqual(closed.tab.appHistory.entries.map((e) => e.url), ["https://a.com/", HISTORY, BOOKMARKS]);
  S().reopenClosed(w);
  const reopened = Object.values(S().tabs).find((t) => t.url === BOOKMARKS);
  assert.ok(reopened);
  assert.equal(reopened.appHistory.index, 2);
  goBack(reopened.id);
  assert.equal(at(reopened.id), HISTORY);
  goBack(reopened.id);
  assert.deepEqual(S().tabs[reopened.id].page, { kind: "adopted", adopt: `restore:${id}`, nav: null }, "the web page's history is asked for by the closed tab's key");
});

test("a saved session keeps a tab's app history and drops a damaged one", () => {
  const good = { entries: [{ url: "https://a.com/", title: "A" }, { url: "ardia://notes/x", title: "X" }], index: 1, kept: { index: 0, key: "tab-1" } };
  const raw = {
    windows: [{ id: "w1", profileId: "default", tabIds: ["t1", "t2"], activeTabIds: { default: "t1" } }],
    tabs: [
      { id: "t1", windowId: "w1", profileId: "default", url: "ardia://notes/x", appHistory: good },
      { id: "t2", windowId: "w1", profileId: "default", url: "ardia://notes/y", appHistory: { entries: [{ url: 5 }], index: 0 } },
    ],
    closedTabs: [{ id: "c1", tab: { url: "ardia://notes/z", profileId: "default", appHistory: { entries: [], index: 0 } } }],
  };
  const session = sessionFromSaved(raw);
  assert.deepEqual(session.tabs.t1.appHistory, good);
  assert.equal("appHistory" in session.tabs.t2, false);
  assert.equal("appHistory" in session.closedTabs[0].tab, false);
});

test("app history stays bounded and its stored form is checked", () => {
  let list;
  for (let i = 0; i < MAX_APP_HISTORY + 10; i++) list = pushedEntry(list, { url: `ardia://notes/${i}`, title: "" });
  assert.equal(list.entries.length, MAX_APP_HISTORY);
  assert.equal(list.index, MAX_APP_HISTORY - 1);
  assert.equal(list.entries[0].url, "ardia://notes/10");
  assert.equal(appHistoryFromDisk({ entries: [{ url: "a", title: "" }], index: 1 }), undefined);
  assert.equal(appHistoryFromDisk({ entries: [{ url: "a", title: "" }], index: 0, kept: { index: 3, key: "k" } }).kept, undefined);
  assert.equal(appHistoryFromDisk("x"), undefined);
});

test("replace swaps only the current entry and keeps the ones ahead", () => {
  const { id } = webTab();
  S().navigate(id, HISTORY);
  S().navigate(id, BOOKMARKS);
  S().navigate(id, DOWNLOADS);
  goBack(id);
  assert.equal(routeAppPage(id, "ardia://bookmarks?x=1", true), true);
  assert.deepEqual(urls(id), ["https://a.com/", HISTORY, "ardia://bookmarks?x=1", DOWNLOADS]);
  assert.equal(h(id).index, 2);
  assert.equal(canGoForward(id, live(id)), true);
});

test("every saved tab list drops a damaged app history: closed windows, parked pins, closed and deleted groups, cleaned tabs", () => {
  const bad = { entries: null, index: 0 };
  const good = { entries: [{ url: "ardia://notes/x", title: "X" }], index: 0 };
  const snap = (appHistory) => ({ url: "ardia://notes/x", profileId: "default", appHistory });
  const session = sessionFromSaved({
    closedWindows: [{ id: "cw", window: { profileId: "default" }, tabs: [snap(bad), snap(good)], groups: [], closedAt: 1 }],
    parkedPins: { default: { tabs: [{ ...snap(bad), id: "p1", groupId: null }], groups: [] } },
    closedGroups: [{ id: "cg", tabs: [snap(bad)] }],
    deletedGroups: [{ id: "dg", tabs: [snap(bad)] }],
    cleanedTabs: [{ id: "ct", tab: snap(bad) }],
  });
  const lists = [session.closedWindows[0].tabs, session.parkedPins.default.tabs, session.closedGroups[0].tabs, session.deletedGroups[0].tabs, [session.cleanedTabs[0].tab]];
  for (const list of lists) assert.equal("appHistory" in list[0], false);
  assert.deepEqual(session.closedWindows[0].tabs[1].appHistory, good);
});

test("an app page opened straight in a new tab is the first stop of its history", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://z.com/" });
  const id = S().newTab(w, { url: HISTORY });
  S().navigate(id, "https://b.com/");
  assert.deepEqual(urls(id), [HISTORY, "https://b.com/"]);
  assert.equal(canGoBack(id, live(id)), true);
  goBack(id);
  assert.equal(at(id), HISTORY);
});
