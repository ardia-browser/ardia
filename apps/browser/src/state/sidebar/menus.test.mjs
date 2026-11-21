import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const { tabMenuItems } = await import("./tabMenu.ts");
const { multiTabMenuItems } = await import("./multiTabMenu.ts");
const { groupMenuItems } = await import("./groupMenu.ts");
const { sidebarMenuItems } = await import("./sidebarMenu.ts");
const { tileFolderContextItems } = await import("./tileFolderUi.ts");
const { addToTileFolder } = await import("../pins/tileFolders.ts");
const { openTabMenu } = await import("./tabMenu.ts");
const { openMultiMenu } = await import("./multiTabMenu.ts");
const { openGroupMenu } = await import("./groupMenu.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");
const { useMedia } = await import("../media/media.ts");
const { webviews } = await import("../../platform/webviews.ts");
const lifecycle = await import("../tabs/tabLifecycle.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "menus-test");

const S = () => useBrowser.getState();
const MODS = [
  ["control", "⌃"],
  ["option", "⌥"],
  ["shift", "⇧"],
  ["command", "⌘"],
];

function render(items, depth = 0, open = () => false) {
  return items.flatMap((it) => {
    const pad = "  ".repeat(depth);
    if (it.separator) return [`${pad}---`];
    let line = pad + it.title;
    if (it.symbol) line += ` [${it.symbol}]`;
    const mods = MODS.filter(([m]) => it.modifiers?.includes(m)).map(([, glyph]) => glyph).join("");
    if (it.key || mods) line += ` ${mods}${(it.key ?? "").toUpperCase()}`;
    if (it.alternate) line += " (alt)";
    if (it.checked) line += " ✓";
    if (it.enabled === false) line += " (off)";
    if (it.children) line += " ›";
    return [line, ...(it.children && open(it) ? render(it.children, depth + 1, open) : [])];
  });
}

const top = (items) => render(items);
const sub = (items, id) => render(items.find((it) => it.id === id)?.children ?? []);

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("a shown tab's menu follows Dia's sections, and its hints are the keys that act on it", () => {
  const { w, ids } = windowWith("a", "b", "c");
  assert.deepEqual(top(tabMenuItems(S(), w, S().tabs[ids[2]])), [
    "Move to Top Apps [pin]",
    "Move to Pinned in Personal ⌥⇧⌘D",
    "---",
    "Open as Split [rectangle.split.2x1] ⌃⇧=",
    "Duplicate [plus.square.on.square]",
    "Open in WebKit",
    "---",
    "New Group with Tab [folder.badge.plus] ⌃⌘N",
    "Move to Profile [person] ›",
    "Move to Window [macwindow] ›",
    "---",
    "Add to Bookmarks… [bookmark] ⌘D",
    "Add Bookmark to Folder ›",
    "---",
    "Copy Link [link] ⇧⌘C",
    "Copy Link as Markdown [link] ⌥⇧⌘C (alt)",
    "---",
    "Rename… [pencil]",
    "Change Icon… [photo]",
    "Mute Tab [speaker.slash]",
    "Mute Site [speaker.slash] ⌥ (alt)",
    "Unload Tab [moon]",
    "---",
    "Close [xmark] ⌘W",
    "Close Other Tabs",
    "Close Tabs Below (off)",
    "Close Tabs Above ⌥ (alt)",
  ]);
});

test("a tab that isn't shown gets no hints, since the keys act on the shown tab", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const lines = top(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.ok(lines.every((l) => !/[⌘⌃]/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("Copy Link as Markdown [link] ⌥ (alt)"));
  assert.ok(lines.includes("Close Tabs Below"));
  assert.ok(lines.includes("Close Tabs Above ⌥ (alt) (off)"));
});

test("destinations sit in submenus: profiles checked, other windows, bookmark folders", () => {
  const { w, ids } = windowWith("a", "b");
  S().createProfile({ name: "Work" });
  const other = S().createWindow({ url: "https://x.com/" });
  const items = tabMenuItems(S(), w, S().tabs[ids[1]]);
  assert.deepEqual(sub(items, "moveToProfile"), ["Personal ✓ (off)", "Work", "---", "New Profile…"]);
  assert.equal(sub(items, "moveToWindow").at(-1), "New Window");
  assert.equal(sub(items, "moveToWindow").length, 3, `one other window: ${other}`);
  assert.deepEqual(sub(items, "bookmarkTo"), ["Bookmarks Bar", "Other Bookmarks", "---", "New Folder…"]);
});

test("a tab in a group leaves it from the menu, and Move to Group lists pinned groups under a header", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const pinned = S().groupTabs([ids[0]], { name: "Pinned One" });
  S().groupTabs([ids[1]], { name: "Work", pinned: false });
  S().groupTabs([ids[2]], { name: "Read", pinned: false });
  const items = tabMenuItems(S(), w, S().tabs[ids[2]]);
  const lines = top(items);
  assert.ok(lines.includes("Remove from Group [folder.badge.minus]"));
  assert.ok(!lines.some((l) => l.startsWith("New Group with Tab")));
  assert.deepEqual(sub(items, "moveToGroup"), ["Pinned (off)", "Pinned One", "---", "Work"]);
  assert.ok(S().groups[pinned].pinned);
});

test("a Top Apps tile with folders off has no New Folder…, and keeps Remove from Folder for one already in a folder", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0], ids[1]], true);
  S().updateSettings({ topAppFolders: false });
  assert.equal(top(tabMenuItems(S(), w, S().tabs[ids[0]])).includes("New Folder… [folder.badge.plus]"), false);
  useBrowser.setState(addToTileFolder(S(), [ids[1]], ids[0]), true);
  assert.equal(top(tabMenuItems(S(), w, S().tabs[ids[0]])).includes("Remove from Folder [folder.badge.minus]"), true);
});

test("a Top Apps tile: unpin first, folders instead of groups, Open in New Window, no close section", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0]], true);
  S().updateSettings({ topAppFolders: true });
  assert.deepEqual(top(tabMenuItems(S(), w, S().tabs[ids[0]])), [
    "Unpin from Top Apps [pin.slash]",
    "Reset Pinned Tab [arrow.uturn.backward] (off)",
    "Move to Pinned in Personal",
    "Edit Pinned Page ›",
    "---",
    "Duplicate [plus.square.on.square]",
    "Open in New Window [macwindow.badge.plus]",
    "Open in WebKit",
    "---",
    "New Folder… [folder.badge.plus]",
    "Move to Profile [person] ›",
    "Move to Window [macwindow] ›",
    "---",
    "Add to Bookmarks… [bookmark]",
    "Add Bookmark to Folder ›",
    "---",
    "Copy Link [link]",
    "Copy Link as Markdown [link] ⌥ (alt)",
    "---",
    "Rename… [pencil]",
    "Change Icon… [photo]",
    "Mute Tab [speaker.slash]",
    "Mute Site [speaker.slash] ⌥ (alt)",
    "Unload Tab [moon]",
  ]);
  assert.deepEqual(sub(tabMenuItems(S(), w, S().tabs[ids[0]]), "pinnedPage"), [
    "Replace Pinned URL with Current (off)",
    "---",
    "Edit Pinned URL…",
  ]);
});

test("a pinned row offers Top Apps as its other place, and a pinned group's tab unpins out of the group", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().pinTabs([ids[0]], true, true);
  const row = top(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.deepEqual(row.slice(0, 4), ["Unpin [pin.slash]", "Reset Pinned Tab [arrow.uturn.backward] (off)", "Move to Top Apps", "Edit Pinned Page ›"]);
  S().groupTabs([ids[1]], { name: "P" });
  const member = top(tabMenuItems(S(), w, S().tabs[ids[1]]));
  assert.deepEqual(member.slice(0, 3), ["Unpin [pin.slash]", "Reset Pinned Tab [arrow.uturn.backward] (off)", "Edit Pinned Page ›"]);
  assert.ok(!member.some((l) => l.startsWith("Remove from Group") || l.startsWith("New Group with Tab") || l.startsWith("Close")));
});

test("every hover card action is in the menu: Reset Pinned Tab once a pinned tab is away, Remove Bookmark on a saved page, Exit Picture in Picture", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0]], true);
  S().updateTab(ids[0], { url: "https://a.com/elsewhere" });
  const tile = top(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.equal(tile[1], "Reset Pinned Tab [arrow.uturn.backward]");
  assert.ok(!sub(tabMenuItems(S(), w, S().tabs[ids[0]]), "pinnedPage").some((l) => l.startsWith("Back to Pinned URL") || l.startsWith("Reset")), "not twice");
  S().toggleBookmark(S().windows[w].profileId, { url: S().tabs[ids[1]].url, title: "b", favicon: null });
  const saved = top(tabMenuItems(S(), w, S().tabs[ids[1]]));
  const edit = saved.findIndex((l) => l.startsWith("Edit Bookmark… [bookmark.fill]"));
  assert.ok(edit > 0);
  assert.equal(saved[edit + 1], "Remove Bookmark");
  assert.ok(!saved.some((l) => l.startsWith("Add to Bookmarks")));
  assert.ok(!saved.some((l) => l.startsWith("Exit Picture in Picture")));
  useMedia.setState((m) => ({ pipOpen: { ...m.pipOpen, [ids[1]]: "video" } }));
  assert.ok(top(tabMenuItems(S(), w, S().tabs[ids[1]])).includes("Exit Picture in Picture [pip.exit]"));
  useMedia.setState((m) => ({ pipOpen: {} }));
});

test("a split pane offers Remove from Split View in place of Open as Split", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().createSplit([ids[0], ids[1]]);
  const lines = top(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.ok(lines.includes("Remove from Split View [rectangle.split.2x1.slash]"));
  assert.ok(!lines.some((l) => l.startsWith("Open as Split")));
});

test("several tabs: counts in the titles, Move N Tabs to Profile, and Close N Tabs without ⌘W", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().groupTabs([ids[0]], { name: "G", pinned: false });
  assert.deepEqual(top(multiTabMenuItems(S(), w, [ids[0], ids[1]])), [
    "Move 2 Tabs to Top Apps [pin]",
    "Move 2 Tabs to Pinned in Personal",
    "---",
    "Unload 2 Tabs [moon]",
    "---",
    "Duplicate 2 Tabs [plus.square.on.square]",
    "---",
    "New Group with 2 Tabs [folder.badge.plus] ⌃⌘N",
    "Remove from Group [folder.badge.minus]",
    "Move to Group [folder] ›",
    "Move 2 Tabs to Profile [person] ›",
    "Move to Window [macwindow] ›",
    "---",
    "Add 2 Tabs to Bookmarks Bar [bookmark]",
    "Add 2 Tabs to Bookmarks Folder ›",
    "---",
    "Copy 2 Links [link]",
    "Copy 2 Links as Markdown [link] ⌥ (alt)",
    "---",
    "Close 2 Tabs [xmark]",
    "Close Other Tabs",
  ]);
});

test("a group header: pin, open, move, customise, copy, then the ways to end it", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const g = S().groupTabs([ids[1], ids[2]], { name: "G", pinned: false });
  assert.deepEqual(top(groupMenuItems(S(), w, g)), [
    "Pin Group [pin]",
    "---",
    "New Tab in Group [plus.app] ⌥⌘T",
    "New Nested Group",
    "Duplicate Group [plus.square.on.square]",
    "---",
    "Move to Profile [person] ›",
    "Move to Window [macwindow] ›",
    "---",
    "Rename… [pencil]",
    "Add Icon… [photo]",
    "Color [paintpalette] ›",
    "---",
    "Copy All Links [link]",
    "Copy All Links as Markdown [link] ⌥ (alt)",
    "---",
    "Ungroup [folder.badge.minus]",
    "Move to Bookmarks Bar [bookmark]",
    "Sleep Tabs [moon.zzz] (off)",
    "Close Group [xmark] ⌃⌘W",
    "Delete Group [trash]",
  ]);
  S().moveGroup(g, { pinned: true });
  const pinned = top(groupMenuItems(S(), w, g));
  assert.equal(pinned[0], "Unpin Group [pin.slash]");
  assert.ok(!pinned.some((l) => l.startsWith("Move to Window")), "a pinned group is in every window already");
  S().activate(ids[0]);
  assert.ok(top(groupMenuItems(S(), w, g)).includes("Close Group [xmark]"), "⌃⌘W closes the shown tab's group, not this one");
});

test("a group's colour menu: None, Neutral, the site's colour, then the palette; picking one sets it", async () => {
  const { w, ids } = windowWith("a", "b");
  const g = S().groupTabs([ids[1]], { name: "G", pinned: false });
  const items = groupMenuItems(S(), w, g);
  assert.deepEqual(sub(items, "color").slice(0, 4), ["None", "Neutral ✓", "Match Site Color (off)", "---"]);
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(shown.find((it) => it.id === "color").children.find((it) => it.title === "Blue").id);
  try {
    await openGroupMenu(w, g);
  } finally {
    shell.showMenu = real;
  }
  assert.equal(S().groups[g].color, "blue");
});

test("Move to Window › New Window moves the tab to a new window", async () => {
  const { w, ids } = windowWith("a", "b");
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(shown.find((it) => it.id === "moveToWindow").children.at(-1).id);
  try {
    await openTabMenu(w, S().tabs[ids[1]]);
  } finally {
    shell.showMenu = real;
  }
  assert.notEqual(S().tabs[ids[1]].windowId, w);
  assert.equal(S().windowOrder.length >= 2, true);
});

test("the sidebar background menu: new things, then the sidebar toggles, Close All Tabs last", () => {
  const { w, ids } = windowWith("a", "b");
  assert.deepEqual(top(sidebarMenuItems(S(), w)), [
    "New Tab [plus.app] ⌘T",
    "Reopen Closed Tab ⇧⌘T (off)",
    "---",
    "New Group [folder.badge.plus]",
    "New Live Folder ›",
    "Add Shared Folder… [person.2]",
    "---",
    "New Profile… [plus]",
    "---",
    "Bookmark All Tabs… [bookmark] ⇧⌘D",
    "---",
    "Collapse Pinned Tabs [rectangle.compress.vertical] (off)",
    "Show Tabs in Sidebar [sidebar.left] ⇧⌘S ✓",
    "Sidebar on Right [sidebar.right]",
    "Auto-Hide Tabs ⌘S",
    "---",
    "Close All Tabs [xmark] ⇧⌘K",
  ]);
  S().updateSettings({ sidebarSide: "right" });
  assert.ok(top(sidebarMenuItems(S(), w)).includes("Sidebar on Right [sidebar.right] ✓"));
  S().updateSettings({ sidebarSide: "left" });
  S().closeTabs([ids[1]]);
  assert.ok(top(sidebarMenuItems(S(), w)).includes("Reopen Closed Tab ⇧⌘T"));
});

test("a Top Apps folder: unpin its tabs, rename, then remove the folder", () => {
  assert.deepEqual(top(tileFolderContextItems(3)), ["Unpin 3 Tabs [pin.slash]", "---", "Rename… [pencil]", "---", "Remove Folder [folder.badge.minus]"]);
});

test("a rebound key moves the hint with it, and an alternate keeps its pair only while the keys match", () => {
  const { w, ids } = windowWith("a", "b");
  S().updateSettings({ shortcuts: { copyUrl: ["l", "shift", "command"] } });
  const lines = top(tabMenuItems(S(), w, S().tabs[ids[1]]));
  assert.ok(lines.includes("Copy Link [link]"), lines.join("\n"));
  assert.ok(lines.includes("Copy Link as Markdown [link] ⌥ (alt)"));
  S().updateSettings({ shortcuts: {} });
});

async function whileMenuIsUp(open, meanwhile, choice) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  let pick;
  shell.showMenu = () => new Promise((resolve) => (pick = resolve));
  try {
    const done = open();
    meanwhile();
    pick(choice);
    await done;
  } finally {
    shell.showMenu = real;
  }
}

test("Open as Split splits the tab the menu was opened on, even if another tab came to the front meanwhile", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[2]]), () => S().activate(ids[0]), "split");
  const split = Object.values(S().splits)[0];
  assert.ok(splitTabIdsOf(split).includes(ids[2]), "c is a pane");
  assert.equal(splitTabIdsOf(split).includes(ids[0]), false, "a, now in front, is left alone");
});

test("a tab menu whose tab left the window meanwhile does nothing, and Close Other Tabs spares tabs that left", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  const other = S().createWindow({ url: "https://x.com/" });
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[2]]), () => S().moveTabsToWindow([ids[2]], other), "close");
  assert.equal(S().tabs[ids[2]]?.windowId, other, "c, now in the other window, stays open");
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[1]]), () => S().moveTabsToWindow([ids[0]], other), "closeOthers");
  assert.equal(S().tabs[ids[0]]?.windowId, other, "a left for the other window and stays open");
  assert.ok(S().tabs[ids[1]]);
});

test("a multi-tab menu acts only on the selected tabs still in its window", async () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const other = S().createWindow({ url: "https://x.com/" });
  await whileMenuIsUp(() => openMultiMenu(w, [ids[1], ids[2]]), () => S().moveTabsToWindow([ids[2]], other), "close");
  assert.equal(S().tabs[ids[1]], undefined, "b closed");
  assert.equal(S().tabs[ids[2]]?.windowId, other, "c, moved away meanwhile, stays open");
});

test("a group menu whose group moved to another window meanwhile does nothing", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  const other = S().createWindow({ url: "https://x.com/" });
  const g = S().groupTabs([ids[1], ids[2]], { name: "Trip", pinned: false });
  await whileMenuIsUp(() => openGroupMenu(w, g), () => S().moveGroupToWindow(g, other), "delete");
  const trip = Object.values(S().groups).find((x) => x.name === "Trip");
  assert.equal(trip?.windowId, other, "the group is still there, in the other window");
  assert.deepEqual(trip.tabIds, [ids[1], ids[2]]);
});

test("the sidebar menu's Reopen Closed Tab is on only when there is something of the shown profile to reopen", () => {
  const { w, ids } = windowWith("a", "b");
  const work = S().createProfile({ name: "Work" });
  const other = S().createWindow({ url: "https://w1.com/", profileId: work });
  S().newTab(other, { url: "https://w2.com/" });
  S().closeTabs([S().windows[other].tabIds[1]]);
  const reopen = () => top(sidebarMenuItems(S(), w)).find((l) => l.startsWith("Reopen Closed Tab"));
  assert.equal(reopen(), "Reopen Closed Tab ⇧⌘T (off)", "only Work has a closed tab");
  assert.ok(top(sidebarMenuItems(S(), other)).includes("Reopen Closed Tab ⇧⌘T"));
  S().closeTabs([ids[1]]);
  assert.equal(reopen(), "Reopen Closed Tab ⇧⌘T");
});

test("Open as Split on a tab that came to the front while its menu was up opens a New Tab beside it", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().activate(ids[0]);
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[2]]), () => S().activate(ids[2]), "split");
  const split = Object.values(S().splits)[0];
  assert.ok(splitTabIdsOf(split).includes(ids[2]), "c is a pane");
  assert.equal(splitTabIdsOf(split).length, 2);
  assert.equal(splitTabIdsOf(split).includes(ids[0]), false, "a isn't");
});

test("Open as Split on a background tab pairs it with the tab in front when the choice lands", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().activate(ids[0]);
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[2]]), () => S().activate(ids[1]), "split");
  assert.deepEqual(Object.values(S().splits).map((v) => [...splitTabIdsOf(v)].sort()), [[ids[1], ids[2]].sort()]);
});

test("a Top App whose page runs in another window offers Unload here too while Keep Top Apps running is on, and Unload puts that page to sleep", async () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://app.com/" });
  const [app] = S().windows[a].tabIds;
  S().newTab(a, { url: "https://x.com/" });
  S().pinTabs([app], true);
  const b = S().createWindow({ url: "https://y.com/" });
  const copy = Object.values(S().tabs).find((t) => t.windowId === b && t.pin?.as === "tile");
  assert.notEqual(copy.page.kind, "loaded");
  const ids = () => tabMenuItems(S(), b, S().tabs[copy.id]).map((i) => i.id);
  assert.ok(!ids().includes("unloadTopApp"), "off: no Unload");
  S().updateSettings({ keepTopAppsRunning: true });
  assert.ok(ids().includes("unloadTopApp"));
  await whileMenuIsUp(() => openTabMenu(b, S().tabs[copy.id]), () => {}, "unloadTopApp");
  assert.equal(S().tabs[app].page.kind, "asleep");
  assert.ok(!ids().includes("unloadTopApp"), "nothing left to unload");
  S().updateSettings({ keepTopAppsRunning: false });
});

function sleepableViews(ids, kept = []) {
  const asked = [];
  webviews.clear();
  for (const id of ids) webviews.set(id, { sleepIfHidden: async (seconds) => (asked.push([id, seconds]), kept.includes(id) ? [26] : []) });
  return asked;
}

test("Sleep Tab is offered for a loaded tab only while nothing shows it, and asks Chrome to sleep it with its protections", async () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const [a, b, c, d] = ids;
  const asked = sleepableViews(ids);
  const offers = (id) => tabMenuItems(S(), w, S().tabs[id]).some((i) => i.id === "sleep");
  assert.equal(offers(d), false, "the tab in front");
  S().createSplit([c, d]);
  assert.equal(offers(c), false, "a pane of the shown split");
  assert.equal(offers(b), true);
  assert.ok(top(tabMenuItems(S(), w, S().tabs[b])).includes("Sleep Tab [moon.zzz]"));
  webviews.delete(a);
  assert.equal(offers(a), false, "no page to sleep");
  takeTabSleepCounts();
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[b]), () => {}, "sleep");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [[b, 0]]);
  assert.equal(takeTabSleepCounts().tabs_slept_from_menu, 1);
  lifecycle.noteDiscarded(b);
  assert.equal(offers(b), false, "already asleep");
  lifecycle.noteReady(b);
  S().pinTabs([b], true, true);
  assert.equal(offers(b), true, "a pinned tab sleeps too");
  webviews.clear();
});

test("Sleep Tabs on a group asks Chrome about its hidden loaded tabs, nested groups included, and counts the ones it kept", async () => {
  const { w, ids } = windowWith("a", "b", "c", "d", "e");
  const [a, b, c, d, e] = ids;
  const outer = S().groupTabs([a, b], { name: "Outer", pinned: false });
  const inner = S().groupTabs([c, e], { name: "Inner", pinned: false });
  S().moveGroup(inner, { pinned: false, parentId: outer });
  S().activate(e);
  const asked = sleepableViews([a, b, c, d, e], [c]);
  S().updateLive(b, { playingAudio: true });
  assert.ok(top(groupMenuItems(S(), w, outer)).includes("Sleep Tabs [moon.zzz]"));
  takeTabSleepCounts();
  await whileMenuIsUp(() => openGroupMenu(w, outer), () => {}, "sleep");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked.map(([id]) => id).sort(), [a, c].sort(), "b plays through Ardia's own player, e is shown and d is outside the group");
  assert.ok(asked.every(([, seconds]) => seconds === 0));
  const counts = takeTabSleepCounts();
  assert.equal(counts.groups_slept_from_menu, 1);
  assert.equal(counts.menu_sleeps_kept_awake, 2, "Ardia kept b and Chrome kept c");
  S().updateLive(b, { playingAudio: false });
  for (const id of [a, b, c]) lifecycle.noteDiscarded(id);
  assert.ok(top(groupMenuItems(S(), w, inner)).includes("Sleep Tabs [moon.zzz] (off)"), "nothing left to sleep");
  for (const id of [a, b, c]) lifecycle.noteReady(id);
  webviews.clear();
});
