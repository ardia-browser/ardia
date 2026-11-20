import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { viewTabIds } = await import("../browser/model.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");
const { takeGroupMoveSplitCounts } = await import("../telemetry/groupMoveSplits.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].url).hostname.replace(".com", "");
const groupsIn = (w, profileId) =>
  Object.values(S().groups)
    .filter((g) => g.windowId === w && g.profileId === profileId)
    .map((g) => ({ name: g.name, pinned: g.pinned, color: g.color, parent: g.parentId ? S().groups[g.parentId].name : null, tabs: g.tabIds.map(host) }))
    .sort((a, z) => a.name.localeCompare(z.name));

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("Move to Window takes a group whole, with its name, colour and nested group, into the other window", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const g = S().groupTabs([ids[1], ids[2], ids[3]], { name: "Trip", pinned: false });
  S().updateGroup(g, { color: "blue" });
  const inner = S().groupTabs([ids[2], ids[3]], { name: "Hotels", pinned: false });
  assert.equal(S().groups[inner].parentId, g);
  const other = S().createWindow({ url: "https://x.com/" });
  assert.equal(S().moveGroupToWindow(g, other), other);
  assert.deepEqual(viewTabIds(S(), w).map(host), ["a"]);
  assert.deepEqual(viewTabIds(S(), other).map(host), ["x", "b", "c", "d"]);
  assert.deepEqual(groupsIn(other, "default"), [
    { name: "Hotels", pinned: false, color: null, parent: "Trip", tabs: ["c", "d"] },
    { name: "Trip", pinned: false, color: "blue", parent: null, tabs: ["b", "c", "d"] },
  ]);
  assert.deepEqual(groupsIn(w, "default"), []);
});

test("Move to Window › New Window opens one with the group in it, and a pinned group stays put", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const g = S().groupTabs([ids[1], ids[2]], { name: "Read", pinned: false });
  const made = S().moveGroupToWindow(g, null);
  assert.ok(made && made !== w);
  assert.deepEqual(groupsIn(made, "default").map((x) => x.tabs), [["b", "c"]]);
  const p = S().groupTabs([ids[0]], { name: "Pinned" });
  assert.equal(S().moveGroupToWindow(p, made), undefined);
  assert.equal(S().groups[p].windowId, w);
});

test("Move to Profile takes a group's tabs to the profile and keeps it a group there, pinned or not", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const work = S().createProfile({ name: "Work" });
  const g = S().groupTabs([ids[1], ids[2]], { name: "Docs" });
  S().moveGroupToProfile(g, work);
  assert.deepEqual(groupsIn(w, "default"), []);
  assert.deepEqual(groupsIn(w, work), [{ name: "Docs", pinned: true, color: null, parent: null, tabs: ["b", "c"] }]);
  assert.ok([ids[1], ids[2]].every((id) => S().tabs[id].profileId === work));
  assert.equal(S().tabs[ids[0]].profileId, "default");
});

for (const shared of [false, true]) {
  test(`Move to Profile keeps a pinned group's saved URLs where its tabs have wandered${shared ? ", tabs shared across windows" : ""}`, () => {
    const { w, ids } = windowWith("a", "b", "c");
    if (shared) S().createWindow({ url: "https://x.com/" }), S().updateSettings({ shareTabsAcrossWindows: true });
    const work = S().createProfile({ name: "Work" });
    S().updateTab(ids[1], { url: "https://b.com/home", title: "B" }, {});
    const g = S().groupTabs([ids[1], ids[2]], { name: "Docs" });
    assert.equal(S().tabs[ids[1]].pinnedUrl, "https://b.com/home");
    S().updateTab(ids[1], { url: "https://b.com/away", title: "B" }, {});
    S().moveGroupToProfile(g, work);
    const moved = Object.values(S().groups).find((x) => x.windowId === w && x.profileId === work && x.name === "Docs");
    assert.ok(moved, "the group is in the profile");
    const urls = moved.tabIds.map((id) => [S().tabs[id].url, S().tabs[id].pinnedUrl]);
    assert.deepEqual(urls, [["https://b.com/away", "https://b.com/home"], ["https://c.com/", "https://c.com/"]]);
  });
}

for (const nested of [false, true]) {
  test(`Move to Window with tabs shared across windows leaves the destination one copy of the group${nested ? " and its nested group" : ""}`, () => {
    const { w, ids } = windowWith("a", "b", "c");
    const other = S().createWindow({ url: "https://x.com/" });
    S().updateSettings({ shareTabsAcrossWindows: true });
    const g = S().groupTabs([ids[1], ids[2]], { name: "Trip", pinned: false });
    const inner = nested ? S().groupTabs([ids[2]], { name: "Hotels", pinned: false }) : null;
    if (inner) assert.equal(S().groups[inner].parentId, g);
    assert.equal(S().moveGroupToWindow(g, other), other);
    const named = (win, name) => Object.values(S().groups).filter((x) => x.windowId === win && x.name === name);
    for (const win of [w, other]) {
      assert.equal(named(win, "Trip").length, 1, `one Trip in ${win === w ? "the source" : "the destination"}`);
      if (nested) assert.equal(named(win, "Hotels").length, 1, `one Hotels in ${win === w ? "the source" : "the destination"}`);
    }
    const trip = named(other, "Trip")[0];
    assert.deepEqual(trip.tabIds.map(host), ["b", "c"]);
    assert.deepEqual(trip.tabIds, [ids[1], ids[2]], "the live tabs moved in");
    if (nested) assert.equal(named(other, "Hotels")[0].parentId, trip.id);
    const grouped = Object.values(S().groups).filter((x) => x.windowId === other).flatMap((x) => x.tabIds);
    assert.ok(grouped.every((id) => S().tabs[id]?.windowId === other), "every member is a tab of the destination");
  });
}

const splitIn = (win) =>
  Object.values(S().splits)
    .filter((v) => v.windowId === win)
    .map((v) => ({ tabs: splitTabIdsOf(v).map(host), orientation: v.orientation, slots: v.slots.map((x) => [x.size, x.stackSizes ?? null]) }));

for (const to of ["window", "profile"]) {
  test(`Move to ${to === "window" ? "Window" : "Profile"} keeps a split inside the group, panes, orientation, sizes and stack`, () => {
    const { w, ids } = windowWith("a", "b", "c", "d", "e");
    const g = S().groupTabs([ids[1], ids[2], ids[3], ids[4]], { name: "Trip", pinned: false });
    const sp = S().createSplit([ids[2], ids[1], ids[3]], "vertical");
    useBrowser.setState((s) => ({ splits: { ...s.splits, [sp]: { ...s.splits[sp], slots: [{ size: 0.6, tabId: ids[2] }, { size: 0.4, stack: [ids[1], ids[3]], stackSizes: [0.3, 0.7] }] } } }));
    const before = splitIn(w);
    let dest = w;
    if (to === "window") dest = S().createWindow({ url: "https://x.com/" }), S().moveGroupToWindow(g, dest);
    else S().moveGroupToProfile(g, S().createProfile({ name: "Work" }));
    const kept = before.find((v) => v.tabs.join() === "c,b,d");
    assert.deepEqual(splitIn(dest).filter((v) => v.tabs.join() === "c,b,d"), [kept]);
    assert.ok(Object.values(S().splits).every((v) => splitTabIdsOf(v).every((id) => S().tabs[id].windowId === v.windowId)));
  });
}

for (const shared of [false, true]) {
  for (const toNewWindow of [false, true]) {
    test(`Move to Window${toNewWindow ? " › New Window" : ""} tells the store's listeners once, with the group's split already back${shared ? ", tabs shared across windows" : ""}`, () => {
      const { w, ids } = windowWith("a", "b", "c", "d");
      const open = toNewWindow ? null : S().createWindow({ url: "https://x.com/" });
      if (shared) S().updateSettings({ shareTabsAcrossWindows: true });
      const g = S().groupTabs([ids[1], ids[2], ids[3]], { name: "Trip", pinned: false });
      S().createSplit([ids[1], ids[2]]);
      assert.deepEqual(splitIn(w).map((v) => v.tabs), [["b", "c"]]);
      const heard = [];
      const stop = useBrowser.subscribe((s) => heard.push(Object.values(s.splits).filter((v) => v.windowId !== w).map((v) => ({ tabs: splitTabIdsOf(v).map(host) }))));
      const dest = S().moveGroupToWindow(g, open);
      stop();
      assert.ok(dest && dest !== w);
      assert.equal(heard.length, 1, "one notification for the whole move");
      assert.ok(heard[0].some((v) => v.tabs.join() === "b,c"), "the split was never heard taken apart");
      assert.deepEqual(splitIn(dest).map((v) => v.tabs), [["b", "c"]]);
    });
  }
}

test("a group move counts the splits that came along, none for a group without one, and the count is taken once", () => {
  const { ids } = windowWith("a", "b", "c", "d");
  const plain = S().groupTabs([ids[0]], { name: "Plain", pinned: false });
  const split = S().groupTabs([ids[1], ids[2], ids[3]], { name: "Trip", pinned: false });
  S().createSplit([ids[1], ids[2]]);
  takeGroupMoveSplitCounts();
  const open = S().createWindow({ url: "https://x.com/" });
  S().moveGroupToWindow(plain, open);
  assert.deepEqual(takeGroupMoveSplitCounts(), { group_move_splits_kept: 0, group_move_splits_dropped: 0 });
  S().moveGroupToWindow(split, open);
  assert.deepEqual(splitIn(open).map((v) => v.tabs), [["b", "c"]]);
  assert.deepEqual(takeGroupMoveSplitCounts(), { group_move_splits_kept: 1, group_move_splits_dropped: 0 });
  assert.deepEqual(takeGroupMoveSplitCounts(), { group_move_splits_kept: 0, group_move_splits_dropped: 0 });
});

test("a move its destination refuses leaves the split where it was, and counts it neither kept nor dropped", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const g = S().groupTabs([ids[1], ids[2], ids[3]], { name: "Trip", pinned: false });
  S().createSplit([ids[1], ids[2]]);
  takeGroupMoveSplitCounts();
  S().moveGroupToWindow(g, "no-such-window");
  assert.deepEqual(splitIn(w).map((v) => v.tabs), [["b", "c"]], "the split is still in the window the group stayed in");
  assert.deepEqual(takeGroupMoveSplitCounts(), { group_move_splits_kept: 0, group_move_splits_dropped: 0 });
});

test("Move to Window with shared tabs keeps the destination group's own members, a split with a local pane included", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const other = S().createWindow({ url: "https://x.com/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const g = S().groupTabs([ids[1], ids[2]], { name: "Trip", pinned: false });
  const bThere = S().windows[other].tabIds.find((id) => S().tabs[id].url === "https://b.com/");
  assert.ok(S().openSplitPane(other, { anchorTabId: bThere, url: "https://local.com/" }).ok);
  const tripIn = (win) => Object.values(S().groups).filter((x) => x.windowId === win && x.name === "Trip");
  const before = tripIn(other)[0].tabIds.map(host);
  assert.deepEqual(before, ["b", "local", "c"]);
  S().moveGroupToWindow(g, other);
  assert.equal(tripIn(other).length, 1);
  assert.deepEqual(tripIn(other)[0].tabIds.map(host), ["b", "local", "c"], "the split's panes stay in the group");
  assert.deepEqual(splitIn(other).map((v) => v.tabs), [["b", "local"]]);
});
