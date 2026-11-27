import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const { inPinnedContainer, pinKeyOf, viewTabIds } = await import("../browser/model.ts");
const { ASLEEP, hasPage, loadedPage, wakeOf, adoptOf, withWake } = await import("../tabs/pageSession.ts");
const { navigationTo } = await import("../browser/model.ts");
const { splitTabIds } = await import("../splits/splits.ts");
const { openGroupMenu } = await import("../sidebar/groupMenu.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { resolveDrop } = await import("../drag/drops.ts");
const { dropTabs } = await import("../pins/actions.ts");
const { takeSharedGroupCounts } = await import("../telemetry/sharedGroupCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "shared-unpin-paths");

const S = () => useBrowser.getState();
const site = (name) => `https://${name}.example/`;
const rows = (w) => viewTabIds(S(), w).map((id) => S().tabs[id]);
const folderIn = (w, key) => Object.values(S().groups).find((g) => g.windowId === w && pinKeyOf(g) === key);
const pageAs = (id, page) => useBrowser.setState((st) => ({ tabs: { ...st.tabs, [id]: { ...st.tabs[id], page } } }));

function splitFolderInThreeWindows() {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("three"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const c = S().createWindow({ url: site("c") });
  const members = ["one", "two", "three"].map((name) => rows(b).find((t) => t.url === site(name)).id);
  const group = S().groupTabs(members, { pinned: true, name: "Reading" });
  S().setFocusedWindow(b);
  S().createSplit(members.slice(0, 2));
  const key = pinKeyOf(S().groups[group]);
  for (const w of [a, b, c]) assert.ok(folderIn(w, key)?.pinned, "every window shows the pinned folder");
  assert.equal(Object.values(S().splits).length, 3, "with its split mirrored");
  const third = folderIn(c, key).tabIds.find((id) => S().tabs[id].url === site("three"));
  pageAs(third, withWake(ASLEEP, "restore:old-three"));
  const loose = folderIn(a, key).tabIds.find((id) => S().tabs[id].url === site("three"));
  pageAs(loose, loadedPage(navigationTo(site("three"))));
  takeSharedGroupCounts();
  return { a, b, c, key, members, families: members.map((id) => pinKeyOf(S().tabs[id])) };
}

function keptEverywhere({ a, b, c, key, families }, from) {
  const closed = S().closedTabs.length;
  return () => {
    assert.equal(S().closedTabs.length, closed, "nothing goes to Recently Closed");
    assert.ok(!Object.values(S().groups).some((g) => g.pinned && pinKeyOf(g) === key), "no window keeps the folder pinned");
    for (const w of [a, b, c]) {
      const folder = folderIn(w, key);
      assert.ok(folder && !folder.pinned, "each window keeps the folder, unpinned");
      assert.equal(rows(w).filter((t) => pinKeyOf(t) === families[2]).length, 1, "the folder's other tab stays listed once in each window");
      const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
      assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window");
    }
    const kept = Object.values(S().splits);
    assert.equal(kept.length, 1, "one split is left");
    assert.equal(kept[0].windowId, from, "in the window the folder was unpinned from");
    assert.deepEqual(splitTabIds(kept[0]).map((id) => pinKeyOf(S().tabs[id])).sort(), families.slice(0, 2).sort());
    assert.ok(Object.values(S().tabs).some((t) => wakeOf(t) === "restore:old-three" || adoptOf(t) === "restore:old-three"), "a tab waiting on its restore keeps it");
    const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
    assert.equal(new Set(live).size, live.length, "one live page per tab");
    assert.ok(Object.values(S().tabs).every((t) => !inPinnedContainer(S(), t.id) || pinKeyOf(t) !== families[2]), "the folder's tab is no longer pinned anywhere");
    assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1, "the Unpin is counted once");
  };
}

async function chooseFromGroupMenu(windowId, groupId, choice) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = () => Promise.resolve(choice);
  try {
    await openGroupMenu(windowId, groupId);
  } finally {
    shell.showMenu = real;
  }
}

for (const where of ["mirror window", "original window"]) {
  test(`Unpin Group in the sidebar menu of a shared split folder's ${where} keeps its tabs in every window`, async () => {
    const fixture = splitFolderInThreeWindows();
    const from = where === "mirror window" ? fixture.a : fixture.b;
    const check = keptEverywhere(fixture, from);
    S().setFocusedWindow(from);
    await chooseFromGroupMenu(from, folderIn(from, fixture.key).id, "pin");
    check();
  });
}

for (const where of ["mirror window", "original window"]) {
  test(`dragging a shared split folder out of the pinned section in its ${where} keeps its tabs in every window`, () => {
    const fixture = splitFolderInThreeWindows();
    const from = where === "mirror window" ? fixture.a : fixture.b;
    const check = keptEverywhere(fixture, from);
    const groupId = folderIn(from, fixture.key).id;
    const drop = resolveDrop(S(), { kind: "group", groupId }, { zone: "list", beforeId: null });
    assert.equal(drop.type, "group");
    assert.equal(drop.placement.pinned, false);
    S().setFocusedWindow(from);
    dropTabs([], drop);
    check();
  });
}

test("dragging a shared pinned folder into a regular folder unpins it in every window and counts it", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("list"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  const key = pinKeyOf(S().groups[group]);
  S().groupTabs([pick(b, "list")], { name: "Regular", pinned: false });
  const regular = Object.values(S().groups).find((g) => g.windowId === a && !g.pinned);
  assert.ok(regular, "the regular folder is mirrored");
  takeSharedGroupCounts();
  const closed = S().closedTabs.length;
  const drop = resolveDrop(S(), { kind: "group", groupId: folderIn(a, key).id }, { zone: "group", groupId: regular.id, beforeId: null });
  assert.equal(drop.type, "group");
  dropTabs([], drop);
  assert.ok(!Object.values(S().groups).some((g) => g.pinned && pinKeyOf(g) === key), "no window keeps it pinned");
  for (const w of [a, b]) for (const name of ["one", "two"]) assert.equal(rows(w).filter((t) => t.url === site(name)).length, 1, `${name} stays listed once in each window`);
  assert.equal(S().closedTabs.length, closed);
  assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1);
});

for (const path of ["Unpin Group in the menu", "updateGroup"]) {
  test(`${path} on a shared folder with a nested folder keeps its tabs in order in every window`, async () => {
    S().hydrate({});
    const a = S().createWindow({ url: site("one") });
    S().newTab(a, { url: site("two"), background: true });
    S().newTab(a, { url: site("three"), background: true });
    S().updateSettings({ shareTabsAcrossWindows: true });
    const b = S().createWindow({ url: site("b") });
    const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
    const group = S().groupTabs(["one", "two", "three"].map((name) => pick(b, name)), { pinned: true, name: "Reading" });
    const inner = S().groupTabs([pick(b, "two")], { name: "Inner" });
    assert.equal(S().groups[inner].parentId, group);
    const key = pinKeyOf(S().groups[group]);
    const innerKey = pinKeyOf(S().groups[inner]);
    const order = (w) => rows(w).map((t) => t.url).filter((url) => [site("one"), site("two"), site("three")].includes(url));
    for (const w of [a, b]) assert.deepEqual(order(w), [site("one"), site("two"), site("three")]);
    takeSharedGroupCounts();
    S().setFocusedWindow(a);
    if (path === "updateGroup") S().updateGroup(folderIn(a, key).id, { pinned: false });
    else await chooseFromGroupMenu(a, folderIn(a, key).id, "pin");
    for (const w of [a, b]) {
      assert.deepEqual(order(w), [site("one"), site("two"), site("three")], "the nested folder's tab keeps its place");
      const root = folderIn(w, key);
      const child = folderIn(w, innerKey);
      assert.ok(root && !root.pinned && child && !child.pinned, "both folders are regular in every window");
      assert.equal(child.parentId, root.id, "the nested folder stays inside its parent");
    }
    assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1);
  });
}

const dragOut = (groupId, spot = { zone: "list", beforeId: null }) => {
  const drop = resolveDrop(S(), { kind: "group", groupId }, spot);
  assert.equal(drop.type, "group");
  dropTabs([], drop);
};

test("dragging a nested folder out of a shared pinned folder keeps it regular in every window, with a background restore", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("x") });
  S().newTab(a, { url: site("y"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const c = S().createWindow({ url: site("c") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const root = S().groupTabs([pick(b, "x"), pick(b, "y")], { pinned: true, name: "Root" });
  const inner = S().groupTabs([pick(b, "y")], { name: "Inner" });
  const rootKey = pinKeyOf(S().groups[root]);
  const innerKey = pinKeyOf(S().groups[inner]);
  for (const w of [a, b, c]) assert.equal(folderIn(w, innerKey)?.parentId, folderIn(w, rootKey)?.id, "the nested folder is mirrored inside its parent");
  const waiting = folderIn(c, innerKey).tabIds[0];
  pageAs(waiting, withWake(ASLEEP, "restore:old-y"));
  takeSharedGroupCounts();
  const closed = S().closedTabs.length;
  S().setFocusedWindow(a);
  dragOut(folderIn(a, innerKey).id);
  for (const w of [a, b, c]) {
    const child = folderIn(w, innerKey);
    assert.ok(child && !child.pinned, "the moved folder is regular in every window");
    assert.equal(child.parentId, undefined, "and no longer inside the pinned folder");
    const parent = folderIn(w, rootKey);
    assert.ok(parent?.pinned, "the pinned folder stays pinned");
    assert.deepEqual(parent.tabIds.map((id) => S().tabs[id].url), [site("x")], "keeping its other tab");
    assert.equal(rows(w).filter((t) => t.url === site("y")).length, 1, "the moved tab is listed once in each window");
  }
  assert.ok(Object.values(S().tabs).some((t) => wakeOf(t) === "restore:old-y" || adoptOf(t) === "restore:old-y"), "the background restore survives");
  assert.equal(S().closedTabs.length, closed);
  assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1);
});

test("dropping a shared folder before a regular tab puts it there in every window, even with another window first in focus order", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("first"), background: true });
  S().newTab(a, { url: site("second"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  const key = pinKeyOf(S().groups[group]);
  S().setFocusedWindow(b);
  S().setFocusedWindow(a);
  assert.equal(S().ui.focusOrder[0], a, "the other window is first in focus order");
  dragOut(folderIn(b, key).id, { zone: "list", beforeId: pick(b, "second") });
  const order = (w) => rows(w).map((t) => t.url).filter((url) => [site("first"), site("one"), site("two"), site("second")].includes(url));
  for (const w of [a, b]) assert.deepEqual(order(w), [site("first"), site("one"), site("two"), site("second")], "the folder lands where it was dropped, in every window");
});

test("unpinning a shared folder that holds only a split keeps both pages, and the folder returns to every window once the split is separated", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true, name: "Pair" });
  const key = pinKeyOf(S().groups[group]);
  S().setFocusedWindow(b);
  S().createSplit(S().groups[group].tabIds);
  const closed = S().closedTabs.length;
  takeSharedGroupCounts();
  dragOut(folderIn(b, key).id);
  const split = Object.values(S().splits).find((v) => v.windowId === b);
  assert.ok(split, "the split stays in the window it was unpinned from");
  assert.ok(folderIn(b, key) && !folderIn(b, key).pinned, "inside the folder, now regular");
  assert.ok(splitTabIds(split).every((id) => hasPage(S().tabs[id])), "with both live pages");
  assert.ok(S().windows[a], "the other window stays open");
  assert.equal(S().closedTabs.length, closed, "nothing goes to Recently Closed");
  assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1);
  S().separateSplit(split.id);
  for (const w of [a, b]) {
    const folder = folderIn(w, key);
    assert.ok(folder && !folder.pinned, "once separated, every window shows the folder");
    assert.deepEqual(folder.tabIds.map((id) => S().tabs[id].url).sort(), [site("one"), site("two")], "with both tabs");
  }
});

function folderBesideASplit() {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("left"), background: true });
  S().newTab(a, { url: site("right"), background: true });
  S().newTab(a, { url: site("after"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true, name: "Reading" });
  const key = pinKeyOf(S().groups[group]);
  S().setFocusedWindow(b);
  S().createSplit([pick(b, "left"), pick(b, "right")]);
  assert.equal(Object.values(S().splits).filter((v) => v.windowId === a).length, 0, "the split is only in its window");
  S().setFocusedWindow(a);
  assert.equal(S().ui.focusOrder[0], a, "the other window is first in focus order");
  return { a, b, key, pick };
}

test("dropping a shared folder just before a window's own split puts it before the same shared tab in every window", () => {
  const { a, b, key, pick } = folderBesideASplit();
  const pane = splitTabIds(Object.values(S().splits).find((v) => v.windowId === b))[0];
  dragOut(folderIn(b, key).id, { zone: "list", beforeId: pane });
  const shared = [site("one"), site("two"), site("after")];
  const order = (w) => rows(w).map((t) => t.url).filter((url) => shared.includes(url));
  for (const w of [a, b]) assert.deepEqual(order(w), shared, "the folder stays before the shared tab after the split, in every window");
  assert.ok(rows(b).findIndex((t) => t.url === site("two")) < rows(b).findIndex((t) => t.id === pane), "and before the split where it was dropped");
});

test("dropping a shared folder into a regular folder that holds only a split keeps it there, in every window, through separating the split", () => {
  const { a, b, key } = folderBesideASplit();
  const split = Object.values(S().splits).find((v) => v.windowId === b);
  const holder = S().groupTabs(splitTabIds(split), { name: "Holder", pinned: false });
  const holderKey = pinKeyOf(S().groups[holder]);
  assert.equal(folderIn(a, holderKey), undefined, "the split's folder is only in its window");
  dragOut(folderIn(b, key).id, { zone: "group", groupId: holder, beforeId: null });
  const check = () => {
    for (const w of [a, b]) {
      const moved = folderIn(w, key);
      const parent = folderIn(w, holderKey);
      assert.ok(moved && !moved.pinned, "the folder is regular in every window");
      assert.ok(parent, "inside the folder it was dropped in, in every window");
      assert.equal(moved.parentId, parent.id);
      assert.deepEqual(moved.tabIds.map((id) => S().tabs[id].url).sort(), [site("one"), site("two")]);
    }
    assert.ok(Object.values(S().groups).every((g) => g.tabIds.length > 0), "no empty folder is left");
  };
  check();
  S().separateSplit(split.id);
  check();
  for (const w of [a, b]) assert.deepEqual(folderIn(w, holderKey).tabIds.map((id) => S().tabs[id].url).sort(), [site("left"), site("one"), site("right"), site("two")].sort(), "the separated tabs join it in every window");
});

test("Unpin Group keeps two splits made separately in two other windows with the same tabs", async () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("app"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const c = S().createWindow({ url: site("c") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  S().pinTabs([pick(b, "app")], true);
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  const key = pinKeyOf(S().groups[group]);
  const splitIn = (w) => Object.values(S().splits).filter((v) => v.windowId === w);
  for (const [w, orientation] of [[b, "horizontal"], [c, "vertical"]]) {
    S().setFocusedWindow(w);
    S().createSplit([pick(w, "app"), pick(w, "one")]);
    const made = splitIn(w)[0];
    useBrowser.setState((st) => ({ splits: { ...st.splits, [made.id]: { ...made, orientation } } }));
  }
  takeSharedGroupCounts();
  const closed = S().closedTabs.length;
  S().setFocusedWindow(a);
  await chooseFromGroupMenu(a, folderIn(a, key).id, "pin");
  assert.equal(splitIn(b)[0]?.orientation, "horizontal", "window B keeps its split");
  assert.equal(splitIn(c)[0]?.orientation, "vertical", "window C keeps its own");
  for (const w of [a, b, c]) {
    assert.ok(folderIn(w, key) && !folderIn(w, key).pinned, "every window keeps the folder, unpinned");
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window, split panes included");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
  assert.equal(S().closedTabs.length, closed);
  assert.equal(takeSharedGroupCounts().shared_groups_unpinned, 1);
});
