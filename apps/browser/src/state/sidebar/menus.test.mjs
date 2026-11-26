import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const { tabMenuItems } = await import("./tabMenu.ts");
const { multiTabMenuItems } = await import("./multiTabMenu.ts");
const { groupMenuItems } = await import("./groupMenu.ts");
const { sidebarMenuItems, runBrowserLayoutChoice, openSidebarMenu } = await import("./sidebarMenu.ts");
const { appMenuItems } = await import("../app/appMenu.ts");
const { tabLayoutOf } = await import("../browser/model.ts");
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
const deep = (items) => render(items, 0, () => true);
const child = (items, ...path) => path.reduce((list, id) => list.find((it) => it.id === id)?.children ?? [], items);
const sub = (items, ...path) => render(child(items, ...path));

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("a shown tab's menu: quick actions, then organize, customize and close, with the keys that act on it", () => {
  const { w, ids } = windowWith("a", "b", "c");
  assert.deepEqual(deep(tabMenuItems(S(), w, S().tabs[ids[2]])), [
    "Copy Link [link] ⇧⌘C",
    "Copy Link as Markdown [link] ⌥⇧⌘C (alt)",
    "Duplicate [plus.square.on.square]",
    "Open in Split View [rectangle.split.2x1] ⌃⇧=",
    "Mute Tab [speaker.slash]",
    "Mute Site [speaker.slash] ⌥ (alt)",
    "---",
    "Pin Tab [pin] ⌥⇧⌘D",
    "Move to [arrow.up.forward.square] ›",
    "  Top Apps [square.grid.2x2]",
    "  ---",
    "  New Group [folder.badge.plus] ⌃⌘N",
    "  ---",
    "  Profile [person] ›",
    "    Personal ✓ (off)",
    "  Window [macwindow] ›",
    "    New Window",
    "Bookmark Tab… [bookmark] ⌘D",
    "---",
    "Customize [slider.horizontal.3] ›",
    "  Rename… [pencil]",
    "  Change Icon… [photo]",
    "  ---",
    "  Open in WebKit [globe]",
    "---",
    "Close Tab [xmark] ⌘W",
    "Close Tabs [xmark.square] ›",
    "  Close Other Tabs",
    "  Close Tabs Below (off)",
    "  Close Tabs Above",
  ]);
});

test("a tab that isn't shown gets no hints, since the keys act on the shown tab, and Close Tabs Above is in plain sight", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const lines = deep(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.ok(lines.every((l) => !/[⌘⌃]/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("Copy Link as Markdown [link] ⌥ (alt)"));
  assert.ok(lines.includes("  Close Tabs Below"));
  assert.ok(lines.includes("  Close Tabs Above (off)"));
});

test("destinations sit under Move to: profiles checked with no New Profile…, other windows, and no bookmark folder list", () => {
  const { w, ids } = windowWith("a", "b");
  S().createProfile({ name: "Work" });
  const other = S().createWindow({ url: "https://x.com/" });
  const items = tabMenuItems(S(), w, S().tabs[ids[1]]);
  assert.deepEqual(sub(items, "moveTo", "moveToProfile"), ["Personal ✓ (off)", "Work"]);
  assert.equal(sub(items, "moveTo", "moveToWindow").at(-1), "New Window");
  assert.equal(sub(items, "moveTo", "moveToWindow").length, 3, `one other window: ${other}`);
  assert.ok(!deep(items).some((l) => l.includes("Add Bookmark to Folder")));
});

test("a tab in a group leaves it from Move to, and Move to › Group lists pinned groups under a header", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const pinned = S().groupTabs([ids[0]], { name: "Pinned One" });
  S().groupTabs([ids[1]], { name: "Work", pinned: false });
  S().groupTabs([ids[2]], { name: "Read", pinned: false });
  const items = tabMenuItems(S(), w, S().tabs[ids[2]]);
  const lines = sub(items, "moveTo");
  assert.ok(lines.includes("Remove from Group [folder.badge.minus]"));
  assert.ok(!lines.some((l) => l.startsWith("New Group")));
  assert.deepEqual(sub(items, "moveTo", "moveToGroup"), ["Pinned (off)", "Pinned One", "---", "Work"]);
  assert.ok(S().groups[pinned].pinned);
});

test("a Top Apps tile with folders off has no New Folder…, and keeps Remove from Folder for one already in a folder", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0], ids[1]], true);
  S().updateSettings({ topAppFolders: false });
  assert.equal(sub(tabMenuItems(S(), w, S().tabs[ids[0]]), "moveTo").includes("New Folder… [folder.badge.plus]"), false);
  useBrowser.setState(addToTileFolder(S(), [ids[1]], ids[0]), true);
  assert.equal(sub(tabMenuItems(S(), w, S().tabs[ids[0]]), "moveTo").includes("Remove from Folder [folder.badge.minus]"), true);
});

test("a Top Apps tile: unpin, Move to Pinned or a folder, pinned URL edits under Customize, and no close section", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0]], true);
  S().updateSettings({ topAppFolders: true });
  assert.deepEqual(deep(tabMenuItems(S(), w, S().tabs[ids[0]])), [
    "Copy Link [link]",
    "Copy Link as Markdown [link] ⌥ (alt)",
    "Duplicate [plus.square.on.square]",
    "Mute Tab [speaker.slash]",
    "Mute Site [speaker.slash] ⌥ (alt)",
    "---",
    "Unpin from Top Apps [pin.slash]",
    "Move to [arrow.up.forward.square] ›",
    "  Pinned in Personal [pin]",
    "  ---",
    "  New Folder… [folder.badge.plus]",
    "  ---",
    "  Profile [person] ›",
    "    Personal ✓ (off)",
    "  Window [macwindow] ›",
    "    New Window",
    "Bookmark Tab… [bookmark]",
    "---",
    "Customize [slider.horizontal.3] ›",
    "  Rename… [pencil]",
    "  Change Icon… [photo]",
    "  ---",
    "  Replace Pinned URL with Current [pin] (off)",
    "  Edit Pinned URL… [link]",
    "  ---",
    "  Open in WebKit [globe]",
  ]);
});

test("a pinned row offers Top Apps as its other place, and a pinned group's tab unpins out of the group", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().pinTabs([ids[0]], true, true);
  const row = tabMenuItems(S(), w, S().tabs[ids[0]]);
  assert.ok(top(row).includes("Unpin [pin.slash]"));
  assert.equal(sub(row, "moveTo")[0], "Top Apps [square.grid.2x2]");
  assert.ok(!top(row).some((l) => l.startsWith("Reset Pinned Tab")), "a pinned tab at its pinned page has nothing to reset");
  S().groupTabs([ids[1]], { name: "P" });
  const member = tabMenuItems(S(), w, S().tabs[ids[1]]);
  assert.ok(top(member).includes("Unpin [pin.slash]"));
  assert.ok(!deep(member).some((l) => l.includes("Remove from Group") || l.includes("New Group") || l.startsWith("Close")));
});

test("every hover card action is in the menu: Reset Pinned Tab once a pinned tab is away, Remove Bookmark on a saved page, Exit Picture in Picture", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0]], true);
  S().updateTab(ids[0], { url: "https://a.com/elsewhere" });
  const tile = top(tabMenuItems(S(), w, S().tabs[ids[0]]));
  assert.equal(tile[tile.indexOf("Unpin from Top Apps [pin.slash]") + 1], "Reset Pinned Tab [arrow.uturn.backward]");
  assert.ok(sub(tabMenuItems(S(), w, S().tabs[ids[0]]), "customize").includes("Replace Pinned URL with Current [pin]"));
  S().toggleBookmark(S().windows[w].profileId, { url: S().tabs[ids[1]].url, title: "b", favicon: null });
  const saved = top(tabMenuItems(S(), w, S().tabs[ids[1]]));
  const edit = saved.indexOf("Edit Bookmark… [bookmark.fill]");
  assert.ok(edit > 0);
  assert.equal(saved[edit + 1], "Remove Bookmark [minus.circle] ⌥ (alt)");
  assert.ok(!saved.some((l) => l.startsWith("Bookmark Tab")));
  assert.ok(!saved.some((l) => l.startsWith("Exit Picture in Picture")));
  useMedia.setState((m) => ({ pipOpen: { ...m.pipOpen, [ids[1]]: "video" } }));
  assert.ok(top(tabMenuItems(S(), w, S().tabs[ids[1]])).includes("Exit Picture in Picture [pip.exit]"));
  useMedia.setState((m) => ({ pipOpen: {} }));
});

test("a split pane offers Remove from Split View in place of Open in Split View, and Close Split View under Close Tabs", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().createSplit([ids[0], ids[1]]);
  const items = tabMenuItems(S(), w, S().tabs[ids[0]]);
  const lines = top(items);
  assert.ok(lines.includes("Remove from Split View [rectangle.split.2x1.slash]"));
  assert.ok(!lines.some((l) => l.startsWith("Open in Split View")));
  assert.equal(sub(items, "closeTabs").at(-1), "Close Split View");
});

test("several tabs: counts in the titles, destinations under Move to, and Close N Tabs without ⌘W", () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().groupTabs([ids[0]], { name: "G", pinned: false });
  assert.deepEqual(top(multiTabMenuItems(S(), w, [ids[0], ids[1]])), [
    "Copy 2 Links [link]",
    "Copy 2 Links as Markdown [link] ⌥ (alt)",
    "Duplicate 2 Tabs [plus.square.on.square]",
    "---",
    "Pin 2 Tabs [pin]",
    "New Group with 2 Tabs [folder.badge.plus] ⌃⌘N",
    "Move to [arrow.up.forward.square] ›",
    "---",
    "Close 2 Tabs [xmark]",
    "Close Other Tabs [xmark.square]",
  ]);
  assert.deepEqual(sub(multiTabMenuItems(S(), w, [ids[0], ids[1]]), "moveTo"), [
    "Top Apps [square.grid.2x2]",
    "---",
    "Group [folder] ›",
    "Remove from Group [folder.badge.minus]",
    "---",
    "Profile [person] ›",
    "Window [macwindow] ›",
    "---",
    "Bookmarks Folder [bookmark] ›",
  ]);
  S().pinTabs([ids[0], ids[1]], true);
  const tiles = multiTabMenuItems(S(), w, [ids[0], ids[1]]);
  assert.ok(top(tiles).includes("Unpin 2 Tabs [pin.slash]"));
  assert.equal(sub(tiles, "moveTo")[0], "Pinned in Personal [pin]");
});

test("a group header: new tab, copy, duplicate, then pin, Move to and Customize, then the ways to end it", () => {
  const { w, ids } = windowWith("a", "b", "c");
  const g = S().groupTabs([ids[1], ids[2]], { name: "G", pinned: false });
  assert.deepEqual(top(groupMenuItems(S(), w, g)), [
    "New Tab in Group [plus.app] ⌥⌘T",
    "Copy All Links [link]",
    "Copy All Links as Markdown [link] ⌥ (alt)",
    "Duplicate Group [plus.square.on.square]",
    "---",
    "Pin Group [pin]",
    "Move to [arrow.up.forward.square] ›",
    "Customize [slider.horizontal.3] ›",
    "Sort Tabs [arrow.up.arrow.down] (off) ›",
    "---",
    "Sleep Tabs [moon.zzz] (off)",
    "Ungroup [folder.badge.minus]",
    "Close Group [xmark]",
    "Delete Group [trash] ⌥ (alt)",
  ]);
  assert.deepEqual(sub(groupMenuItems(S(), w, g), "moveTo"), ["Profile [person] ›", "Window [macwindow] ›", "Bookmarks Bar [bookmark]"]);
  assert.deepEqual(sub(groupMenuItems(S(), w, g), "sortTabs"), ["By Site [globe] (off)", "By Title [textformat] (off)"]);
  assert.deepEqual(sub(groupMenuItems(S(), w, g), "customize"), ["Rename… [pencil]", "Add Icon… [photo]", "Color [paintpalette] ›", "---", "New Nested Group [folder.badge.plus]"]);
  S().moveGroup(g, { pinned: true });
  const pinned = groupMenuItems(S(), w, g);
  assert.ok(top(pinned).includes("Unpin Group [pin.slash]"));
  assert.ok(!sub(pinned, "moveTo").some((l) => l.startsWith("Window")), "a pinned group is in every window already");
});

test("a group's colour menu: None, Neutral, the site's colour, then the palette; picking one sets it", async () => {
  const { w, ids } = windowWith("a", "b");
  const g = S().groupTabs([ids[1]], { name: "G", pinned: false });
  const items = groupMenuItems(S(), w, g);
  assert.deepEqual(sub(items, "customize", "color").slice(0, 4), ["None", "Neutral ✓", "Match Site Color (off)", "---"]);
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(shown.find((it) => it.id === "customize").children.find((it) => it.id === "color").children.find((it) => it.title === "Blue").id);
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
  shell.showMenu = (shown) => Promise.resolve(shown.find((it) => it.id === "moveTo").children.find((it) => it.id === "moveToWindow").children.at(-1).id);
  try {
    await openTabMenu(w, S().tabs[ids[1]]);
  } finally {
    shell.showMenu = real;
  }
  assert.notEqual(S().tabs[ids[1]].windowId, w);
  assert.equal(S().windowOrder.length >= 2, true);
});

test("the sidebar background menu: new things, Browser Layout, then Close Duplicate Tabs and Close All Tabs last; no setup-only rows", () => {
  const { w, ids } = windowWith("a", "b");
  assert.deepEqual(deep(sidebarMenuItems(S(), w)), [
    "New Tab [plus.app] ⌘T",
    "New Tab in Split View [rectangle.split.2x1] ⌃⇧=",
    "Reopen Closed Tab [clock.arrow.circlepath] ⇧⌘T (off)",
    "---",
    "New Group [folder.badge.plus]",
    "New Live Folder [bolt] ›",
    "  Pull Requests [arrow.triangle.pull]",
    "  Documents [doc.text]",
    "Add Shared Folder… [person.2]",
    "Sort Tabs [arrow.up.arrow.down] (off) ›",
    "  By Site [globe] (off)",
    "  By Title [textformat] (off)",
    "---",
    "Browser Layout [sidebar.left] ›",
    "  Sidebar on Left [sidebar.left] ✓",
    "  Sidebar on Right [sidebar.right]",
    "  Top Tab Bar [menubar.rectangle] ⇧⌘S",
    "  ---",
    "  Address Bar in Toolbar [menubar.rectangle] ✓",
    "  Address Bar in Sidebar [sidebar.left]",
    "  Compact Toolbar [rectangle.compress.vertical]",
    "  ---",
    "  Auto-Hide Tabs [eye.slash] ⌘S",
    "  Minimalism Mode [rectangle.leftthird.inset.filled] ⌃⌘M",
    "  Bookmarks Bar [bookmark] ⇧⌘B",
    "---",
    "Close Duplicate Tabs [square.on.square] (off)",
    "Close All Tabs [xmark] ⇧⌘K",
  ]);
  S().newTab(w, { url: "https://a.com/#again", background: true });
  assert.ok(top(sidebarMenuItems(S(), w)).includes("Close Duplicate Tabs [square.on.square]"), "on once two tabs show the same page");
  S().closeTabs([S().windows[w].tabIds.at(-1)]);
  S().updateSettings({ sidebarSide: "right" });
  assert.ok(sub(sidebarMenuItems(S(), w), "browserLayout").includes("Sidebar on Right [sidebar.right] ✓"));
  S().updateSettings({ sidebarSide: "left" });
  S().closeTabs([ids[1]]);
  assert.ok(top(sidebarMenuItems(S(), w)).includes("Reopen Closed Tab [clock.arrow.circlepath] ⇧⌘T"));
});

test("Browser Layout moves the tabs between the sides and the top in one pick, and the address bar choices follow the layout", () => {
  const { w } = windowWith("a");
  const layout = () => sub(sidebarMenuItems(S(), w), "browserLayout");
  runBrowserLayoutChoice(w, "layout:top");
  assert.equal(tabLayoutOf(S(), w), "top");
  assert.ok(layout().includes("Top Tab Bar [menubar.rectangle] ✓"));
  assert.ok(layout().includes("Sidebar on Left [sidebar.left] ⇧⌘S"), "the layout toggle shortcut moves to the layout it switches to");
  assert.ok(!layout().some((l) => l.startsWith("Address Bar in")), "with tabs on top the address bar is in the toolbar");
  assert.ok(layout().includes("Compact Toolbar [rectangle.compress.vertical]"));
  runBrowserLayoutChoice(w, "layout:sidebarRight");
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.equal(S().settings.sidebarSide, "right");
  runBrowserLayoutChoice(w, "layout:top");
  assert.ok(layout().includes("Sidebar on Right [sidebar.right] ⇧⌘S"));
  runBrowserLayoutChoice(w, "layout:sidebarLeft");
  assert.equal(S().settings.sidebarSide, "left");
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  runBrowserLayoutChoice(w, "layout:addressSidebar");
  assert.equal(S().settings.addressBar, "sidebar");
  assert.ok(!layout().some((l) => l.startsWith("Compact Toolbar")), "no toolbar to compact once the address bar is in the sidebar");
  runBrowserLayoutChoice(w, "layout:addressToolbar");
  runBrowserLayoutChoice(w, "layout:minimalism");
  assert.equal(S().settings.minimalismMode, true);
  assert.ok(!layout().some((l) => l.startsWith("Address Bar in")), "minimalism suppresses the address bar placement choices");
  assert.ok(!layout().some((l) => l.startsWith("Compact Toolbar")), "minimalism suppresses Compact Toolbar");
  runBrowserLayoutChoice(w, "layout:addressSidebar");
  assert.equal(S().settings.addressBar, "toolbar");
  runBrowserLayoutChoice(w, "layout:minimalism");
  S().updateSettings({ bookmarksBar: "always" });
  const priv = S().createWindow({ kind: "private" });
  assert.ok(!sub(sidebarMenuItems(S(), priv), "browserLayout").some((l) => l.startsWith("Bookmarks Bar")), "private windows hide the bookmarks bar row");
  runBrowserLayoutChoice(priv, "layout:bookmarksBar");
  assert.equal(S().settings.bookmarksBar, "always");
  S().updateSettings({ bookmarksBar: "never" });
  S().updateSettings({ showBookmarks: false });
  assert.ok(!layout().some((l) => l.startsWith("Bookmarks Bar")), "bookmarks off, no bar row");
  S().updateSettings({ showBookmarks: true });
  const small = S().createWindow({ kind: "small", url: "https://small.example/" });
  assert.ok(!appMenuItems(S(), small).some((it) => it.id === "browserLayout"), "Little Ardia omits Browser Layout from the app menu");
  runBrowserLayoutChoice(small, "layout:sidebarRight");
  assert.equal(S().settings.sidebarSide, "left");
  runBrowserLayoutChoice(small, "layout:top");
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.equal(runBrowserLayoutChoice(w, "newTab"), false);
});

test("multi-select Move to › Top Apps converts pinned rows into Top Apps tiles", async () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs(ids, true, true);
  assert.equal(S().tabs[ids[0]].pin?.as, "row");
  assert.equal(S().tabs[ids[1]].pin?.as, "row");
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = () => Promise.resolve("pinTiles");
  try {
    await openMultiMenu(w, ids);
  } finally {
    shell.showMenu = real;
  }
  assert.equal(S().tabs[ids[0]].pin?.as, "tile");
  assert.equal(S().tabs[ids[1]].pin?.as, "tile");
});

test("a Top Apps folder: rename, then unpin its tabs or remove the folder", () => {
  assert.deepEqual(top(tileFolderContextItems(3)), ["Rename… [pencil]", "---", "Unpin 3 Tabs [pin.slash]", "Remove Folder [folder.badge.minus]"]);
});

test("New Tab in Split View from the sidebar menu opens a new tab beside the active tab", async () => {
  const { w, ids } = windowWith("a", "b");
  S().activate(ids[0]);
  await whileMenuIsUp(() => openSidebarMenu(w), () => {}, "newTabInSplit");
  const split = Object.values(S().splits)[0];
  assert.ok(split);
  const panes = splitTabIdsOf(split);
  assert.equal(panes.length, 2);
  assert.equal(panes[0], ids[0]);
  assert.notEqual(panes[1], ids[0]);
  assert.notEqual(panes[1], ids[1]);
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

test("Open in Split View splits the tab the menu was opened on, even if another tab came to the front meanwhile", async () => {
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
  assert.equal(reopen(), "Reopen Closed Tab [clock.arrow.circlepath] ⇧⌘T (off)", "only Work has a closed tab");
  assert.ok(top(sidebarMenuItems(S(), other)).includes("Reopen Closed Tab [clock.arrow.circlepath] ⇧⌘T"));
  S().closeTabs([ids[1]]);
  assert.equal(reopen(), "Reopen Closed Tab [clock.arrow.circlepath] ⇧⌘T");
});

test("Open in Split View on a tab that came to the front while its menu was up opens a New Tab beside it", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  S().activate(ids[0]);
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[ids[2]]), () => S().activate(ids[2]), "split");
  const split = Object.values(S().splits)[0];
  assert.ok(splitTabIdsOf(split).includes(ids[2]), "c is a pane");
  assert.equal(splitTabIdsOf(split).length, 2);
  assert.equal(splitTabIdsOf(split).includes(ids[0]), false, "a isn't");
});

test("Open in Split View on a background tab pairs it with the tab in front when the choice lands", async () => {
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

function sleepableViews(ids, kept = [], refusals = {}, discarded = []) {
  const asked = [];
  webviews.clear();
  for (const id of ids)
    webviews.set(id, {
      sleepIfHidden: async (seconds) => (asked.push([id, seconds]), refusals[id] ?? (kept.includes(id) ? [26] : [])),
      discard: async () => (discarded.push(id), "discarded"),
    });
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

test("Sleep Tab sleeps a pinned row, a Top App and a regular tab that Chrome keeps only for automatic sleep, and keeps one holding typed input", async () => {
  const { w, ids } = windowWith("tile", "row", "plain", "typed", "front");
  const [tile, row, plain, typed] = ids;
  S().pinTabs([tile], true, false);
  S().pinTabs([row], true, true);
  const discarded = [];
  sleepableViews(ids, [], { [tile]: [25, 13], [row]: [25], [plain]: [7, 23], [typed]: [25, 26] }, discarded);
  takeTabSleepCounts();
  for (const id of [tile, row, plain, typed]) {
    assert.ok(tabMenuItems(S(), w, S().tabs[id]).some((i) => i.id === "sleep"), `Sleep Tab offered for ${id}`);
    await whileMenuIsUp(() => openTabMenu(w, S().tabs[id]), () => {}, "sleep");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(discarded.sort(), [tile, row, plain].sort(), "the typed-in tab stays awake");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_from_menu, 4);
  assert.equal(counts.menu_sleeps_past_automatic, 3);
  assert.equal(counts.menu_sleeps_kept_awake, 1);
  assert.equal(counts.menu_sleep_kept_reason, "typedInput");
  const late = ids[4];
  let shownMeanwhile;
  webviews.set(late, { sleepIfHidden: async () => (S().activate(late), (shownMeanwhile = true), [25]), discard: async () => (discarded.push(late), "discarded") });
  S().activate(plain);
  await whileMenuIsUp(() => openTabMenu(w, S().tabs[late]), () => {}, "sleep");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(shownMeanwhile);
  assert.ok(!discarded.includes(late), "a tab shown while Chrome answered is not discarded");
  webviews.clear();
});

test("Sleep Tab puts a page left by a form post, one with an unload prompt or one running a download to sleep when asked, but still keeps typed input", async () => {
  const { w, ids } = windowWith("posted", "prompt", "downloading", "postedTyped", "front");
  const [posted, prompt, downloading, postedTyped] = ids;
  const discarded = [];
  sleepableViews(ids, [], { [posted]: [100], [prompt]: [101, 7], [downloading]: [102], [postedTyped]: [100, 26] }, discarded);
  takeTabSleepCounts();
  for (const id of [posted, prompt, downloading, postedTyped]) {
    await whileMenuIsUp(() => openTabMenu(w, S().tabs[id]), () => {}, "sleep");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(discarded.sort(), [posted, prompt, downloading].sort(), "only automatic sleep is held back by these; the user's own Sleep Tab goes ahead");
  const counts = takeTabSleepCounts();
  assert.equal(counts.menu_sleeps_past_automatic, 3);
  assert.equal(counts.menu_sleep_kept_reason, "typedInput", "typed text still keeps a posted page awake");
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
