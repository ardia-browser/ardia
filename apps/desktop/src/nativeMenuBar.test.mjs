import assert from "node:assert/strict";
import { test } from "node:test";
import { appMenuItems } from "./appMenu.ts";
import {
  createNativeMenuBar,
  MENU_PICK,
  menuPickFor,
  NATIVE_MENU_MAX_DEPTH,
  NATIVE_MENU_MAX_ITEMS,
  NATIVE_MENU_SYNC_MS,
  nativeMenuKey,
  nativeMenuSpec,
  REQUEST_WINDOW_CLOSE_METHOD,
  utilityMenuSpec,
  nativeMenuTitle,
  SET_MAIN_MENU_METHOD,
  SET_MENU_STATE_METHOD,
  structuralMenuState,
} from "./nativeMenuBar.ts";

const MAC = (process.env.ARDIA_DESKTOP_MODE ?? "linux") === "mac";
const PRIMARY = MAC ? 8 : 2;
const DISABLED = ["back", "togglePin:tile", "reopenClosedWindow", "moveSplitPaneLeft"];
const state = (overrides = {}) => ({
  checked: ["setAppearance:dark", "toggleFullUrl"],
  disabled: DISABLED,
  titles: { bookmarkPage: "Edit Bookmark…" },
  profiles: [{ id: "p1", title: "Personal", current: true }, { id: "p2", title: "Work" }],
  windows: [{ id: "w2", title: "Docs" }],
  bookmarkFolders: [{ id: "bar", title: "Bookmarks Bar" }],
  recentBookmarks: [{ id: "b1", title: "Example", url: "https://example.com" }],
  bookmarksBar: [{ id: "f1", title: "Work", children: [{ id: "b2", title: "", url: "https://ardia.dev" }] }],
  otherBookmarks: [],
  recentlyClosed: [{ id: "c1", title: "Closed tab" }],
  recentlyClosedGroups: [],
  warnBeforeQuitting: false,
  extensions: [{ id: "ext", title: "uBlock", enabled: true }],
  ...overrides,
});
const shortcuts = new Map([
  ["newTab", { key: "t", modifiers: ["command"] }],
  ["std:quit:", { key: "q", modifiers: ["command"] }],
  ["back", { key: "[", modifiers: ["command"] }],
  ["nextTab", { key: "\t", modifiers: ["control"] }],
  ["zoomIn", { key: "", modifiers: ["command", "option"] }],
  ["devTools", { key: "", modifiers: ["command", "function"] }],
]);
const EDIT = { edit: { disabled: new Set() } };
const build = (overrides) => {
  const shown = state(overrides);
  return { items: appMenuItems(structuralMenuState(shown), shortcuts, new Set(), EDIT), flags: { disabled: shown.disabled, checked: shown.checked, titles: shown.titles } };
};
const spec = (overrides) => {
  const { items, flags } = build(overrides);
  return nativeMenuSpec(items, flags);
};
const find = (items, predicate) => {
  for (const item of items) {
    if (predicate(item)) return item;
    const nested = item.children && find(item.children, predicate);
    if (nested) return nested;
  }
  return undefined;
};
const walk = (items, visit, depth = 1) => {
  for (const item of items) {
    visit(item, depth);
    if (item.children) walk(item.children, visit, depth + 1);
  }
};
const byTitle = (items, title) => items.find((item) => item.title === title);

test("the native menu bar has the RN macOS menus in order, with the system Window, Help and Bookmarks menus", () => {
  const bar = spec();
  assert.deepEqual(bar.map((menu) => menu.title), ["Ardia", "File", "Edit", "View", "Tabs", "Bookmarks", "History", "Extensions", "Window", "Help"]);
  assert.equal(byTitle(bar, "Window").role, "windowMenu");
  assert.equal(byTitle(bar, "Help").role, "helpMenu");
  assert.equal(byTitle(bar, "Bookmarks").role, "bookmarksMenu");
  assert.deepEqual(byTitle(bar, "Bookmarks").children.map((item) => item.command), ["bookmarkPage", "bookmarkAllTabs", "manageBookmarks", "exportBookmarks"]);
  const profiles = byTitle(byTitle(bar, "Window").children, "Profiles");
  assert.deepEqual(profiles.children.filter((item) => item.command === "switchProfile").map((item) => [item.arg, item.checked, !!item.fixedCheck]), [["p1", true, true], ["p2", false, false]]);
});

test("edit, window, about and full-screen items use AppKit roles, and window actions without a role come back as picks", () => {
  const bar = spec();
  assert.deepEqual(byTitle(bar, "Edit").children.filter((item) => item.role).map((item) => item.role), ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]);
  assert.equal(find(bar, (item) => item.title === "About Ardia").role, "about");
  assert.equal(find(bar, (item) => item.title === "Minimize").role, "minimize");
  assert.equal(find(bar, (item) => item.title === "Maximize").role, "zoom");
  assert.equal(find(bar, (item) => item.title === "Enter Full Screen").role, "toggleFullScreen");
  assert.equal(find(bar, (item) => item.title === "Minimize All"), undefined);
  const close = find(bar, (item) => item.title === "Close Window");
  assert.deepEqual([close.role, close.command], ["close", undefined]);
  const quit = find(bar, (item) => item.command === "quit");
  assert.deepEqual([quit.id, quit.key, quit.modifiers], ["std:quit:", "q", 8]);
});

test("commands carry their state id, shortcut and current flags, and a renamed item keeps its default title", () => {
  const bar = spec();
  const newTab = find(bar, (item) => item.command === "newTab" && !item.arg);
  assert.deepEqual([newTab.id, newTab.key, newTab.modifiers, newTab.enabled], ["newTab", "t", PRIMARY, true]);
  const back = find(bar, (item) => item.command === "back");
  assert.deepEqual([back.enabled, back.key, back.modifiers], [false, "[", PRIMARY]);
  assert.equal(find(bar, (item) => item.id === "setAppearance:dark").checked, true);
  assert.equal(find(bar, (item) => item.id === "setAppearance:light").checked, false);
  assert.equal(find(bar, (item) => item.id === "moveSplitPaneLeft").enabled, false);
  assert.equal(find(bar, (item) => item.id === "togglePin:tile"), undefined);
  const bookmark = find(byTitle(bar, "Bookmarks").children, (item) => item.id === "bookmarkPage");
  assert.deepEqual([bookmark.title, bookmark.defaultTitle], ["Edit Bookmark…", "Bookmark This Page"]);
  assert.equal(find(bar, (item) => item.command === "nextTab").key, "Tab");
  assert.deepEqual([find(bar, (item) => item.command === "zoomIn").key, find(bar, (item) => item.command === "zoomIn").modifiers], ["Up", PRIMARY | 4]);
  assert.equal(find(bar, (item) => item.command === "devTools").key, "F8");
  assert.equal(find(bar, (item) => item.command === "openExtension").arg, "ext");
  assert.equal(find(bar, (item) => item.command === "restoreClosed").arg, "c1");
});

test("the structure ignores flags, so only profile, window, extension or shortcut changes rebuild the bar", () => {
  const { items } = build();
  const flagged = build({ disabled: [...DISABLED, "forward"], checked: ["toggleSidebar"], titles: { bookmarkPage: "Edit" } });
  assert.deepEqual(nativeMenuSpec(items), nativeMenuSpec(flagged.items));
  assert.notDeepEqual(nativeMenuSpec(items), nativeMenuSpec(build({ profiles: [{ id: "p1", title: "Personal", current: true }] }).items));
  assert.notDeepEqual(nativeMenuSpec(items), nativeMenuSpec(build({ extensions: [] }).items));
  const structural = structuralMenuState(state());
  assert.deepEqual([structural.disabled, structural.checked, structural.titles, structural.bookmarksBar], [["togglePin:tile"], [], {}, []]);
});

test("every item meets the native menu limits even with hostile titles and huge lists", () => {
  const windows = Array.from({ length: 600 }, (_, index) => ({ id: `w${index}`, title: `Window\u0007${index}\n${"é".repeat(150)}` }));
  const bar = spec({ windows, recentlyClosed: windows });
  let count = 0;
  walk(bar, (item, depth) => {
    count++;
    assert.ok(depth <= NATIVE_MENU_MAX_DEPTH);
    if (item.separator) return;
    assert.ok(new TextEncoder().encode(item.title).length <= 200, item.title);
    assert.doesNotMatch(item.title, /[\u0000-\u001f\u007f]/);
    if (item.command) assert.match(item.command, /^[A-Za-z0-9._:-]{1,96}$/);
    if (item.key) assert.match(item.key, /^([\x21-\x7e]|Enter|Escape|Backspace|Delete|Tab|Space|Up|Down|Left|Right|Home|End|F([1-9]|1[0-9]|20))$/);
    if (item.modifiers !== undefined) assert.ok(item.modifiers >= 0 && item.modifiers <= 15);
    if (item.children) assert.equal(item.command, undefined);
  });
  assert.ok(count <= NATIVE_MENU_MAX_ITEMS);
});

test("titles and keys are cleaned the way the native menu validates them", () => {
  assert.equal(nativeMenuTitle("  a\tb\nc "), "a b c");
  const long = nativeMenuTitle("😀".repeat(80));
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.equal(long, "😀".repeat(50));
  assert.equal(nativeMenuKey("T"), "t");
  assert.equal(nativeMenuKey("\r"), "Enter");
  assert.equal(nativeMenuKey(""), "F1");
  assert.equal(nativeMenuKey("F12"), "F12");
  assert.equal(nativeMenuKey(""), undefined);
  assert.equal(nativeMenuKey(""), undefined);
  assert.equal(nativeMenuKey("é"), undefined);
});

function barHarness({ supports = [SET_MAIN_MENU_METHOD, SET_MENU_STATE_METHOD], overrides = {} } = {}) {
  const sent = [];
  const timers = new Map();
  let next = 0;
  let changed = null;
  let current = { ...overrides };
  const bar = createNativeMenuBar({
    supports: (method) => supports.includes(method),
    invoke: async (method, args) => void sent.push({ method, args }),
    build: () => build(current),
    subscribe: (listener) => {
      changed = listener;
      return () => void (changed = null);
    },
    timeout: (run, ms) => {
      timers.set(++next, { run, ms });
      return next;
    },
    clearTimeout: (handle) => timers.delete(handle),
  });
  const settle = () => new Promise(setImmediate);
  const fire = async () => {
    for (const [handle, timer] of [...timers]) {
      timers.delete(handle);
      assert.equal(timer.ms, NATIVE_MENU_SYNC_MS);
      timer.run();
    }
    await settle();
  };
  return {
    bar, sent, timers, settle, fire,
    change: (next) => {
      current = { ...current, ...next };
      changed?.();
    },
    listening: () => !!changed,
  };
}

test("without setMainMenu nothing is sent or watched", async () => {
  const h = barHarness({ supports: [] });
  await h.settle();
  assert.equal(h.bar.active, false);
  assert.deepEqual(h.sent, []);
  assert.equal(h.listening(), false);
});

test("every window pushes its own bar at start and on structural changes, and the host shows the key window's", async () => {
  const h = barHarness();
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].method, SET_MAIN_MENU_METHOD);
  assert.equal(h.sent[0].args.items[0].title, "Ardia");
  h.change({ disabled: [...DISABLED, "forward"] });
  h.change({ checked: ["toggleSidebar"] });
  assert.equal(h.timers.size, 1);
  await h.fire();
  assert.equal(h.sent.length, 1);
  h.change({ extensions: [] });
  await h.fire();
  assert.equal(h.sent.length, 2);
  assert.equal(find(h.sent[1].args.items, (item) => item.command === "openExtension"), undefined);
  h.change({ profiles: [{ id: "p1", title: "Personal", current: true }] });
  await h.fire();
  assert.equal(h.sent.length, 3);
  assert.equal(byTitle(h.sent[2].args.items[8].children, "Profiles"), undefined);
});

test("without setMenuState a flag change rebuilds the bar", async () => {
  const h = barHarness({ supports: [SET_MAIN_MENU_METHOD] });
  await h.settle();
  h.change({ disabled: [...DISABLED, "forward"] });
  await h.fire();
  assert.equal(h.sent.length, 2);
  assert.equal(find(h.sent[1].args.items, (item) => item.id === "forward").enabled, false);
});

test("stop removes the store listener and any pending push", async () => {
  const h = barHarness();
  await h.settle();
  h.change({ extensions: [] });
  h.bar.stop();
  assert.equal(h.listening(), false);
  assert.equal(h.timers.size, 0);
});

test("menu picks reach only the window the host sent them to", () => {
  assert.equal(menuPickFor("w1", { command: MENU_PICK, arg: "window:close", windowId: "w1" }), "window:close");
  assert.equal(menuPickFor("w1", { command: MENU_PICK, arg: "window:close" }), "window:close");
  assert.equal(menuPickFor("w1", { command: MENU_PICK, arg: "window:close", windowId: "w2" }), null);
  assert.equal(menuPickFor("w1", { command: "newTab", arg: "x", windowId: "w1" }), null);
  assert.equal(menuPickFor("w1", { command: MENU_PICK, arg: 7, windowId: "w1" }), null);
  assert.equal(menuPickFor("w1", null), null);
});

test("Quit and full screen keep the Mac's own shortcuts, and the Ardia menu has Services, Hide and Show All before Quit", () => {
  const bar = spec();
  const quit = find(bar, (item) => item.command === "quit");
  assert.deepEqual([quit.key, quit.modifiers], ["q", 8]);
  const full = find(bar, (item) => item.role === "toggleFullScreen");
  assert.deepEqual([full.key, full.modifiers], ["f", 10]);
  const app = bar[0].children;
  const titles = app.map((item) => (item.separator ? "---" : item.title));
  const at = titles.indexOf("Services");
  assert.deepEqual(titles.slice(at - 1), ["---", "Services", "---", "Hide Ardia", "Hide Others", "Show All", "---", "Quit Ardia"]);
  assert.deepEqual(app.slice(at, at + 4).map((item) => [item.role, item.key, item.modifiers]), [["services", undefined, undefined], [undefined, undefined, undefined], ["hide", "h", 8], ["hideOthers", "h", 12]]);
  assert.deepEqual(app[at].children, []);
  assert.equal(new Set(app.filter((item) => item.key).map((item) => `${item.key}:${item.modifiers}`)).size, app.filter((item) => item.key).length);
});

test("a menu that fills the budget uses the native limit, which counts items but not the bar itself, and never passes it", () => {
  const windows = Array.from({ length: 900 }, (_, index) => ({ id: `w${index}`, title: `W${index}` }));
  let count = 0;
  walk(spec({ windows }), () => count++);
  assert.ok(count <= NATIVE_MENU_MAX_ITEMS && count >= NATIVE_MENU_MAX_ITEMS - 4, String(count));
});

test("desktop shortcuts map to the keys that press them, so a recorded Command chord shows as Command", async () => {
  const { keyboardCombo } = await import("./shortcuts.ts");
  const recorded = keyboardCombo({ code: "KeyT", key: "t", ctrlKey: false, metaKey: true, altKey: false, shiftKey: true });
  const { items } = build();
  const withRecorded = items.map((menu) => menu.id === "menu:File"
    ? { ...menu, children: menu.children.map((child) => child.id === "newTab" ? { ...child, key: recorded.key, modifiers: recorded.modifiers } : child) }
    : menu);
  const newTab = find(nativeMenuSpec(withRecorded), (item) => item.command === "newTab" && !item.arg);
  assert.deepEqual([newTab.key, newTab.modifiers], ["t", 8 | 1], "a recorded Command-Shift-T shows as Command-Shift-T");
  const control = keyboardCombo({ code: "KeyT", key: "t", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  const viaControl = items.map((menu) => menu.id === "menu:File"
    ? { ...menu, children: menu.children.map((child) => child.id === "newTab" ? { ...child, key: control.key, modifiers: control.modifiers } : child) }
    : menu);
  assert.equal(find(nativeMenuSpec(viaControl), (item) => item.command === "newTab" && !item.arg).modifiers, 2);
  const bar = spec();
  assert.equal(find(bar, (item) => item.command === "newTab" && !item.arg).modifiers, PRIMARY, "the default New Tab binding shows the key that presses it: Command-T on the Mac");
  assert.deepEqual(byTitle(bar, "Edit").children.filter((item) => item.role).map((item) => [item.key, item.modifiers]), [["z", 8], ["z", 9], ["x", 8], ["c", 8], ["v", 8], ["v", 13], ["a", 8]]);
});

test("Close Window uses the host's close request when it has one and AppKit's own close otherwise", () => {
  const { items, flags } = build();
  const standalone = find(nativeMenuSpec(items, flags), (item) => item.title === "Close Window");
  assert.deepEqual([standalone.role, standalone.command, standalone.key, standalone.modifiers], ["close", undefined, "w", 9]);
  const hosted = find(nativeMenuSpec(items, flags, { closeThroughHost: true }), (item) => item.title === "Close Window");
  assert.deepEqual([hosted.role, hosted.command, hosted.arg], [undefined, MENU_PICK, "window:close"]);
  assert.equal(REQUEST_WINDOW_CLOSE_METHOD, "ArdiaShell.requestWindowClose");
});

test("Settings and Import get their own bar with Close Window, editing and the window menu", () => {
  const bar = utilityMenuSpec();
  assert.deepEqual(bar.map((menu) => menu.title), ["Ardia", "File", "Edit", "Window", "Help"]);
  assert.deepEqual(bar[1].children.map((item) => [item.title, item.role]), [["Close Window", "close"]]);
  assert.deepEqual(utilityMenuSpec({ closeThroughHost: true })[1].children.map((item) => [item.command, item.arg]), [[MENU_PICK, "window:close"]]);
  assert.deepEqual(bar[2].children.filter((item) => item.role).map((item) => item.role), ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]);
  assert.deepEqual([bar[0].children.at(-1).command, bar[0].children.at(-1).key], ["quit", "q"]);
  assert.equal(bar[3].role, "windowMenu");
  assert.equal(bar[4].role, "helpMenu");
  assert.deepEqual(bar[0].children.map((item) => item.role ?? (item.separator ? "---" : item.title)), ["about", "---", "services", "---", "hide", "hideOthers", "showAll", "---", "Quit Ardia"]);
  let count = 0;
  walk(bar, () => count++);
  assert.ok(count < NATIVE_MENU_MAX_ITEMS);
});

test("on the Mac, New Tab, Close Tab, the command bar and Settings show Command, never Control", async () => {
  if (!MAC) return;
  const { linuxMenuShortcuts } = await import("./shortcuts.ts");
  const real = new Map(linuxMenuShortcuts({}, [], {}).map((shortcut) => [shortcut.id, { key: shortcut.key, modifiers: shortcut.modifiers }]));
  const shown = state();
  const bar = nativeMenuSpec(appMenuItems(structuralMenuState(shown), real, new Set(), EDIT), { disabled: shown.disabled, checked: shown.checked, titles: shown.titles });
  for (const [command, key] of [["newTab", "t"], ["closeTab", "w"], ["focusCommandBar", "l"], ["openSettings", ","]]) {
    const item = find(bar, (candidate) => candidate.command === command && !candidate.arg);
    assert.deepEqual([command, item?.key, item?.modifiers], [command, key, 8], `${command} is Command-${key}`);
  }
});

test("the menu bar's File › Share keeps Copy Link and Email Link and leaves the system services and More… to the host", () => {
  const items = [
    { id: "menu:File", title: "File", children: [
      { id: "menu:Share", title: "Share", children: [
        { id: "share:via:copy", title: "Copy Link" },
        { id: "share:via:email", title: "Email Link" },
        { separator: true },
        { id: "share:via:AirDrop", title: "AirDrop" },
        { id: "share:via:ardia.more", title: "More…" },
      ] },
    ] },
  ];
  const [file] = nativeMenuSpec(items);
  const [share] = file.children;
  assert.equal(share.role, "shareServices");
  assert.deepEqual(share.children.map((child) => [child.command, child.arg]), [["share", "via:copy"], ["share", "via:email"]]);
});
