import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { canSort, sortableCount, sorting, unsorting } = await import("./sortTabs.ts");
const { sortTabs, sortTabsMenuItem } = await import("./sortTabsUi.ts");
const { groupEntries, sidebarEntries } = await import("./entries.ts");
const { groupMenuItems, openGroupMenu } = await import("./groupMenu.ts");
const { sidebarMenuItems, openSidebarMenu } = await import("./sidebarMenu.ts");
const { runSidebarCommand } = await import("./commands.ts");
const { barActions } = await import("../omnibox/barActions.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");
const { useToasts } = await import("../app/toasts.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();
const reset = () => S().hydrate({});
const label = (id) => S().tabs[id].title;
const describe = (entry) => {
  if (entry.startsWith("g:")) return `[${S().groups[entry.slice(2)].name}]`;
  if (entry.startsWith("s:")) return `{${splitTabIdsOf(S().splits[entry.slice(2)]).map(label).join("|")}}`;
  return label(entry.slice(2));
};
const list = (w) => sidebarEntries(S(), w).list.map(describe);
const rows = (groupId) => groupEntries(S(), groupId).map(describe);
const pinnedRows = (w) => model.viewTabIds(S(), w).filter((id) => model.isPinnedRow(S().tabs[id])).map(label);
const tiles = (w) => model.viewTabIds(S(), w).filter((id) => model.pinSection(S().tabs[id]) === "tile").map(label);

function windowWith(...tabs) {
  const w = S().createWindow({ url: "https://start.com/" });
  const first = S().windows[w].tabIds[0];
  const ids = tabs.map(([url, title]) => {
    const id = S().newTab(w, { url, background: true });
    S().updateTab(id, { title });
    return id;
  });
  S().closeTabs([first]);
  return { w, ids };
}

function sort(target, key) {
  let done = null;
  useBrowser.setState((s) => {
    const [next, sorted] = sorting(s, target, key);
    done = sorted;
    return next;
  });
  return done;
}

async function choose(open, pick) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(pick(shown));
  try {
    await open();
  } finally {
    shell.showMenu = real;
  }
}

const sortChild = (items, key) => items.find((it) => it.id === "sortTabs").children.find((it) => it.id === `sortTabs:${key}`);

test("By Site orders by the site's name without case, then by title, and a tab with no site goes last", () => {
  reset();
  const { w } = windowWith(
    ["https://news.zeta.com/a", "Zeta news"],
    ["https://www.Apple.com/mac", "Mac"],
    ["about:blank", "Blank"],
    ["https://apple.com/ipad", "iPad"],
    ["https://beta.org/", "Beta"],
  );
  const done = sort({ windowId: w }, "site");
  assert.ok(done);
  assert.deepEqual(list(w), ["iPad", "Mac", "Beta", "Zeta news", "Blank"]);
  assert.equal(done.tabs, 5);
});

test("By Title orders without case by the locale, and equal titles keep the order they had", () => {
  reset();
  const { w, ids } = windowWith(
    ["https://c.com/", "cherry"],
    ["https://s.com/1", "Same"],
    ["https://a.com/", "Apple"],
    ["https://e.com/", "éclair"],
    ["https://s.com/2", "same"],
    ["https://b.com/", "banana"],
  );
  sort({ windowId: w }, "title");
  assert.deepEqual(list(w), ["Apple", "banana", "cherry", "éclair", "Same", "same"]);
  const same = sidebarEntries(S(), w).list.filter((e) => S().tabs[e.slice(2)]?.title.toLowerCase() === "same");
  assert.deepEqual(same, [`t:${ids[1]}`, `t:${ids[4]}`]);
});

test("in the tab list groups keep their places and the loose tabs are sorted into the places around them", () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://g1.com/", "g one"], ["https://g2.com/", "g two"], ["https://a.com/", "Ant"], ["https://m.com/", "Moth"]);
  S().groupTabs([ids[1], ids[2]], { pinned: false, name: "Kept" });
  assert.deepEqual(list(w), ["Zed", "[Kept]", "Ant", "Moth"]);
  sort({ windowId: w }, "title");
  assert.deepEqual(list(w), ["Ant", "[Kept]", "Moth", "Zed"]);
});

test("sorting a group orders its own tabs and leaves a nested group in its place with its order untouched", () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://y.com/", "Yak"], ["https://x.com/", "Xerus"], ["https://a.com/", "Ant"], ["https://loose.com/", "Loose"]);
  const [z, y, x, a] = ids;
  const outer = S().groupTabs([z, y, x, a], { pinned: false, name: "Outer" });
  const inner = S().groupTabs([y, x], { name: "Inner" });
  assert.deepEqual(rows(outer), ["Zed", "[Inner]", "Ant"]);
  sort({ windowId: w, groupId: outer }, "title");
  assert.deepEqual(rows(outer), ["Ant", "[Inner]", "Zed"]);
  assert.deepEqual(rows(inner), ["Yak", "Xerus"]);
  assert.deepEqual(list(w), ["[Outer]", "Loose"]);
});

test("a split moves as one row, keyed by its first pane", () => {
  reset();
  const { w, ids } = windowWith(["https://m.com/", "Moth"], ["https://z.com/", "Zed"], ["https://a.com/", "Ant"], ["https://b.com/", "Bee"]);
  const [, zed, ant] = ids;
  const split = S().createSplit([zed, ant]);
  assert.deepEqual(list(w), ["Moth", "{Zed|Ant}", "Bee"]);
  sort({ windowId: w }, "title");
  assert.deepEqual(list(w), ["Bee", "Moth", "{Zed|Ant}"]);
  assert.deepEqual(splitTabIdsOf(S().splits[split]), [zed, ant]);
  const order = S().windows[w].tabIds;
  assert.equal(order.indexOf(ant) - order.indexOf(zed), 1, "nothing lands between the panes");
});

test("sorting the tab list never moves pinned rows, pinned folders or Top Apps", () => {
  reset();
  const { w, ids } = windowWith(
    ["https://r2.com/", "Row Z"],
    ["https://r1.com/", "Row A"],
    ["https://t2.com/", "Tile Z"],
    ["https://t1.com/", "Tile A"],
    ["https://f2.com/", "Folder Z"],
    ["https://f1.com/", "Folder A"],
    ["https://z.com/", "Zed"],
    ["https://a.com/", "Ant"],
  );
  S().pinTabs([ids[0], ids[1]], true, true);
  S().pinTabs([ids[2], ids[3]], true, false);
  const folder = S().groupTabs([ids[4], ids[5]], { pinned: true, name: "Folder" });
  sort({ windowId: w }, "title");
  assert.deepEqual(list(w), ["Ant", "Zed"]);
  assert.deepEqual(pinnedRows(w), ["Row Z", "Row A"]);
  assert.deepEqual(tiles(w), ["Tile Z", "Tile A"]);
  assert.deepEqual(rows(folder), ["Folder Z", "Folder A"]);
});

test("a pinned folder's menu sorts its pins, and another window of the profile shows the new order", async () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://a.com/", "Ant"], ["https://m.com/", "Moth"]);
  const folder = S().groupTabs(ids, { pinned: true, name: "Folder" });
  const other = S().createWindow({ url: "https://other.com/" });
  await choose(() => openGroupMenu(w, folder), (shown) => sortChild(shown, "title").id);
  assert.deepEqual(rows(folder), ["Ant", "Moth", "Zed"]);
  const mirrored = Object.values(S().groups).find((g) => g.pinned && g.windowId === other && g.name === "Folder");
  assert.ok(mirrored);
  assert.deepEqual(rows(mirrored.id), ["Ant", "Moth", "Zed"]);
});

test("an order that is already sorted disables its item and sorting it changes nothing", () => {
  reset();
  const { w } = windowWith(["https://a.com/", "Ant"], ["https://b.com/", "Bee"]);
  assert.equal(canSort(S(), { windowId: w }, "title"), false);
  assert.equal(sortChild(sidebarMenuItems(S(), w), "title").enabled, false);
  const before = S();
  assert.equal(sorting(before, { windowId: w }, "title")[0], before);
  assert.equal(sortTabs({ windowId: w }, "title"), false);
  assert.equal(useToasts.getState().toasts[w] ?? null, null, "no toast for a sort that did nothing");
  assert.equal(S(), before);
});

test("with fewer than two tabs or splits there is nothing to sort, and the menu says so", () => {
  reset();
  const { w, ids } = windowWith(["https://b.com/", "Bee"], ["https://a.com/", "Ant"], ["https://c.com/", "Cat"]);
  const g = S().groupTabs([ids[0], ids[1]], { pinned: false, name: "G" });
  assert.equal(sortableCount(S(), { windowId: w }), 1);
  assert.equal(sortTabsMenuItem(S(), { windowId: w }).enabled, false);
  assert.equal(sortTabsMenuItem(S(), { windowId: w, groupId: g }).enabled, true);
  assert.equal(sortableCount(S(), { windowId: w, groupId: g }), 2);
});

test("Undo puts the old order back, and changing the list takes Undo away", async () => {
  reset();
  const { w } = windowWith(["https://z.com/", "Zed"], ["https://a.com/", "Ant"], ["https://m.com/", "Moth"]);
  const before = list(w);
  await choose(() => openSidebarMenu(w), (shown) => sortChild(shown, "title").id);
  assert.deepEqual(list(w), ["Ant", "Moth", "Zed"]);
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast?.title, "Sorted 3 Tabs");
  assert.equal(toast?.action?.title, "Undo");
  S().updateTab(sidebarEntries(S(), w).list[0].slice(2), { title: "Ant, renamed" });
  assert.equal(useToasts.getState().toasts[w]?.action?.title, "Undo", "a title change doesn't change the list");
  toast.action.run();
  assert.deepEqual(list(w), before.map((t) => (t === "Ant" ? "Ant, renamed" : t)));

  assert.equal(sortTabs({ windowId: w }, "title"), true);
  assert.equal(useToasts.getState().toasts[w]?.action?.title, "Undo");
  S().placeTabs([sidebarEntries(S(), w).list[2].slice(2)], { pinned: false, beforeId: sidebarEntries(S(), w).list[0].slice(2) });
  assert.equal(useToasts.getState().toasts[w] ?? null, null, "moving a sorted tab by hand takes Undo away");
});

test("Undo from the toast still restores the order after the window opens, activates and closes other tabs", async () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://a.com/", "Ant"], ["https://m.com/", "Moth"], ["https://b.com/", "Bee"]);
  const spare = S().newTab(w, { url: "https://spare.com/", background: true });
  S().updateTab(spare, { title: "Spare" });
  assert.deepEqual(list(w), ["Zed", "Ant", "Moth", "Bee", "Spare"]);
  await choose(() => openSidebarMenu(w), (shown) => sortChild(shown, "title").id);
  assert.deepEqual(list(w), ["Ant", "Bee", "Moth", "Spare", "Zed"]);
  const fresh = S().newTab(w, { url: "https://fresh.com/" });
  S().updateTab(fresh, { title: "Fresh" });
  S().activate(ids[2]);
  S().closeTabs([spare]);
  S().updateSettings({ minimalismMode: !S().settings.minimalismMode });
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast?.action?.title, "Undo");
  const shown = list(w);
  toast.action.run();
  const back = ["Zed", "Ant", "Moth", "Bee"];
  assert.deepEqual(list(w).filter((t) => back.includes(t)), back);
  assert.equal(list(w).indexOf("Fresh"), shown.indexOf("Fresh"), "a tab opened after the sort stays where it is");
  assert.equal(useToasts.getState().toasts[w] ?? null, null);
});

test("a sort whose list changed since can't be undone", () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://a.com/", "Ant"], ["https://m.com/", "Moth"]);
  const done = sort({ windowId: w }, "title");
  assert.ok(done);
  S().placeTabs([ids[0]], { pinned: false, beforeId: ids[1] });
  const moved = S();
  assert.equal(unsorting(moved, done), moved);
  assert.deepEqual(list(w), ["Zed", "Ant", "Moth"]);
});

test("the group header and the tab list offer Sort Tabs by Site and by Title", () => {
  reset();
  const { w, ids } = windowWith(["https://b.com/", "Bee"], ["https://a.com/", "Ant"], ["https://zeta.com/", "Cat"], ["https://apple.com/", "Zed"]);
  const g = S().groupTabs([ids[0], ids[1]], { pinned: false, name: "G" });
  const group = groupMenuItems(S(), w, g).find((it) => it.id === "sortTabs");
  assert.equal(group.title, "Sort Tabs");
  assert.deepEqual(group.children.map((c) => [c.title, c.enabled]), [["By Site", true], ["By Title", true]]);
  const sidebar = sidebarMenuItems(S(), w).find((it) => it.id === "sortTabs");
  assert.deepEqual(sidebar.children.map((c) => [c.title, c.enabled]), [["By Site", true], ["By Title", false]]);
});

test("the command bar lists both sorts only with two or more entries, and the commands sort the window's tab list", () => {
  reset();
  const { w, ids } = windowWith(["https://z.com/", "Zed"], ["https://a.com/", "Ant"]);
  const sortIds = () => barActions(S(), w).filter((a) => a.id.startsWith("sortTabs:")).map((a) => `${a.id} ${a.title}`);
  assert.deepEqual(sortIds(), ["sortTabs:site Sort Tabs by Site", "sortTabs:title Sort Tabs by Title"]);
  assert.equal(runSidebarCommand("sortTabs", "title", w), true);
  assert.deepEqual(list(w), ["Ant", "Zed"]);
  S().closeTabs([ids[0]]);
  assert.deepEqual(sortIds(), []);
});
