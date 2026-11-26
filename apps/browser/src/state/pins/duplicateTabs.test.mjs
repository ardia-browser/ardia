import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { duplicateTabIds, hasDuplicateTabs } = await import("./duplicateTabs.ts");
const { closeDuplicateTabs } = await import("../sidebar/clearTabs.ts");
const { sidebarMenuItems } = await import("../sidebar/sidebarMenu.ts");
const { menuState } = await import("../commands/menuState.ts");
const { barActions } = await import("../omnibox/barActions.ts");
const { useToasts } = await import("../app/toasts.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");

const S = () => useBrowser.getState();
const label = (id) => {
  const u = new URL(S().tabs[id].url);
  return `${u.hostname.split(".")[0]}${u.pathname.replace(/\/$/, "")}${u.hash}`;
};
const order = (w) => model.viewTabIds(S(), w).map(label);
const shown = (w) => label(model.activeTabId(S(), w));
const toastOf = (w) => useToasts.getState().toasts[w] ?? null;

function windowWith(...urls) {
  S().hydrate({});
  S().updateSettings({ cmdClickCreatesTabGroup: false, newTabPosition: "bottom" });
  const w = S().createWindow({ url: "https://home.com/" });
  const ids = urls.map((url) => S().newTab(w, { url, background: true }));
  return { w, home: S().windows[w].tabIds[0], ids };
}

const usedAt = (ids) => ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: 1_000 + i }));

test("the selected copy stays, and the same page with a fragment or a trailing slash counts as the same page", () => {
  const { w, ids: [a1, b, a2, a3] } = windowWith("https://a.com/x", "https://b.com/", "https://a.com/x/", "https://a.com/x#top");
  usedAt([a1, b, a3, a2]);
  S().activate(a3);
  assert.deepEqual(duplicateTabIds(S(), w), [a1, a2]);
  const closed = S().closeDuplicateTabs(w);
  assert.equal(closed.entries.length, 2);
  assert.deepEqual(order(w), ["home", "b", "a/x#top"]);
  assert.equal(shown(w), "a/x#top");
  assert.deepEqual(S().closedTabs.slice(-2).map((c) => c.tab.url), ["https://a.com/x", "https://a.com/x/"], "they land in Recently Closed");
});

test("without the selected tab among them, the copy used last stays, and a tie keeps the higher one", () => {
  const { w, ids: [a1, a2, a3, b1, b2] } = windowWith("https://a.com/", "https://a.com/", "https://a.com/", "https://b.com/", "https://b.com/");
  usedAt([a1, a3, a2]);
  S().updateTab(b1, { lastActiveAt: 5_000 });
  S().updateTab(b2, { lastActiveAt: 5_000 });
  assert.notEqual(model.activeTabId(S(), w), a1);
  assert.deepEqual(duplicateTabIds(S(), w), [a1, a3, b2]);
  S().closeDuplicateTabs(w);
  assert.ok(S().tabs[a2], "the most recently active copy stays");
  assert.ok(S().tabs[b1], "on a tie the higher copy stays");
  assert.deepEqual(order(w), ["home", "a", "b"]);
});

test("pinned rows and Top Apps never close, and an unpinned copy of a pinned row's page does", () => {
  const { w, ids: [row, rowTwin, tile, tileTwin, loose, rowCopy] } = windowWith(
    "https://row.com/",
    "https://row.com/",
    "https://tile.com/",
    "https://tile.com/",
    "https://loose.com/",
    "https://row.com/#later",
  );
  S().pinTabs([row, rowTwin], true, true);
  S().pinTabs([tile, tileTwin], true);
  S().activate(loose);
  usedAt([rowCopy]);
  assert.deepEqual(duplicateTabIds(S(), w), [rowCopy]);
  S().closeDuplicateTabs(w);
  assert.ok(S().tabs[row] && S().tabs[rowTwin], "pinned rows stay, even two of one page");
  assert.ok(S().tabs[tile] && S().tabs[tileTwin], "Top Apps tiles stay");
  assert.equal(S().tabs[rowCopy], undefined, "the unpinned copy of the pinned row closes");
  assert.equal(hasDuplicateTabs(S(), w), false);
});

test("an unpinned tab on a Top App's page is not a duplicate of it", () => {
  const { w, ids: [tile, copy] } = windowWith("https://tile.com/", "https://tile.com/");
  S().pinTabs([tile], true);
  assert.ok(S().tabs[copy]);
  assert.deepEqual(duplicateTabIds(S(), w), []);
});

test("a selected tab on a pinned row's page stays beside it", () => {
  const { w, ids: [row, copy] } = windowWith("https://row.com/", "https://row.com/");
  S().pinTabs([row], true, true);
  S().activate(copy);
  assert.deepEqual(duplicateTabIds(S(), w), []);
});

test("tabs playing sound and tabs in a split stay, and count as the copy that stays", () => {
  const { w, home, ids: [m1, m2, m3, s1, other, s2, s3] } = windowWith(
    "https://music.com/",
    "https://music.com/",
    "https://music.com/",
    "https://split.com/",
    "https://other.com/",
    "https://split.com/",
    "https://split.com/",
  );
  S().updateLive(m1, { playingAudio: true });
  S().updateLive(m3, { playingAudio: true });
  const split = S().createSplit([s1, other]);
  S().activate(home);
  usedAt([s3, s2]);
  assert.deepEqual(duplicateTabIds(S(), w), [m2, s2, s3]);
  S().closeDuplicateTabs(w);
  assert.ok(S().tabs[m1] && S().tabs[m3], "both tabs playing sound stay");
  assert.equal(S().tabs[m2], undefined);
  assert.deepEqual(splitTabIdsOf(S().splits[split]), [s1, other], "the split stays whole");
  assert.equal(S().tabs[s2], undefined, "a loose copy of a split pane's page closes, even the one used last");
  assert.equal(S().tabs[s3], undefined);
});

test("only the profile on screen counts: another profile's copies in the window stay, and don't make the shown ones duplicates", () => {
  const { w, ids: [a] } = windowWith("https://a.com/");
  const home = S().windows[w].profileId;
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const w1 = S().newTab(w, { url: "https://a.com/", background: true });
  const w2 = S().newTab(w, { url: "https://a.com/", background: true });
  S().switchProfile(w, home);
  assert.deepEqual(duplicateTabIds(S(), w), []);
  assert.equal(S().closeDuplicateTabs(w), null);
  const copy = S().newTab(w, { url: "https://a.com/", background: true });
  usedAt([copy, a]);
  S().closeDuplicateTabs(w);
  assert.ok(S().tabs[w1] && S().tabs[w2], "the hidden profile's tabs stay");
  assert.ok(S().tabs[a]);
  assert.equal(S().tabs[copy], undefined);
});

test("with nothing to close, the sidebar menus disable it and the command bar leaves it out; with duplicates they offer it", () => {
  const { w, ids: [a, b] } = windowWith("https://a.com/", "https://b.com/");
  const item = () => sidebarMenuItems(S(), w).find((it) => it.id === "closeDuplicates");
  const inBar = () => barActions(S(), w).some((x) => x.id === "closeDuplicateTabs");
  assert.equal(item().title, "Close Duplicate Tabs");
  assert.equal(item().enabled, false);
  S().setFocusedWindow(w);
  assert.ok(!menuState(S()).disabled.includes("closeDuplicateTabs"), "the menu bar keeps it on, as Close All Tabs, so it never reads hidden tabs' pages");
  assert.equal(inBar(), false);
  S().newTab(w, { url: "https://b.com/#again", background: true });
  assert.equal(item().enabled, true);
  assert.equal(inBar(), true);
  const action = barActions(S(), w).find((x) => x.id === "closeDuplicateTabs");
  assert.ok(action.keywords.includes("dedupe") && action.keywords.includes("duplicates"));
  assert.equal(action.hint, undefined, "no default shortcut");
  assert.ok(S().tabs[a] && S().tabs[b]);
});

test("Close Duplicate Tabs shows a toast whose Undo restores the tabs in place with their groups, and goes once the window changes", () => {
  const { w, ids: [a1, b1, a2, c, b2, d] } = windowWith("https://a.com/", "https://b.com/", "https://a.com/", "https://c.com/", "https://b.com/", "https://d.com/");
  const g = S().createGroup([a2, c], { name: "G" });
  S().updateGroup(g, { color: "blue" });
  S().activate(d);
  usedAt([a1, b2, a2, b1]);
  const before = order(w);
  const groupBefore = S().groups[g].tabIds.map(label);
  closeDuplicateTabs(w);
  assert.deepEqual(order(w), ["home", "b", "a", "c", "d"]);
  assert.deepEqual(S().groups[g].tabIds.map(label), ["a", "c"], "the grouped copy used last stays in its group");
  const toast = toastOf(w);
  assert.equal(toast.title, "Closed 2 Duplicate Tabs");
  assert.equal(toast.action.title, "Undo");
  toast.action.run();
  assert.deepEqual(order(w), before);
  assert.deepEqual(S().groups[g].tabIds.map(label), groupBefore);
  assert.equal(S().groups[g].color, "blue");
  assert.equal(shown(w), "d", "the selection is unchanged");
  assert.equal(S().closedTabs.filter((t) => t.tab.url === "https://a.com/" || t.tab.url === "https://b.com/").length, 0, "undone tabs leave Recently Closed");
  closeDuplicateTabs(w);
  assert.ok(toastOf(w));
  S().reopenClosedTab(w);
  assert.equal(toastOf(w), null, "reopening one of them another way dismisses the toast");
});

test("a group whose only tab was a duplicate comes back whole on Undo", () => {
  const { w, ids: [a1, b, a2] } = windowWith("https://a.com/", "https://b.com/", "https://a.com/");
  const g = S().createGroup([a1], { name: "Solo" });
  S().activate(b);
  usedAt([a1, a2]);
  const closed = S().closeDuplicateTabs(w);
  assert.deepEqual(closed.entries.map((e) => e.tabId), [a1]);
  assert.equal(Object.values(S().groups).some((x) => x.name === "Solo" && x.tabIds.length), false);
  S().undoClearTabs(closed);
  const back = Object.values(S().groups).filter((x) => x.name === "Solo");
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].tabIds.map(label), ["a"]);
  assert.deepEqual(order(w), ["home", "a", "b", "a"]);
  assert.equal(back[0].id, g);
});
