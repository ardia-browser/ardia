import assert from "node:assert/strict";
import { test } from "node:test";
import { appMenuChoice, appMenuItems } from "./appMenu.ts";

const state = (overrides = {}) => ({
  checked: ["setAppearance:dark", "toggleFullUrl"],
  disabled: ["back", "togglePin:tile", "reopenClosedWindow"],
  titles: { bookmarkPage: "Edit Bookmark…" },
  profiles: [{ id: "p1", title: "Personal", current: true }, { id: "p2", title: "Work" }],
  windows: [{ id: "w2", title: "Docs" }],
  bookmarkFolders: [{ id: "bar", title: "Bookmarks Bar" }],
  recentBookmarks: [{ id: "b1", title: "Example", url: "https://example.com" }],
  bookmarksBar: [{ id: "f1", title: "Work", children: [{ id: "b2", title: "", url: "https://ardia.dev" }] }],
  otherBookmarks: [],
  recentlyClosed: [],
  recentlyClosedGroups: [],
  warnBeforeQuitting: false,
  extensions: [{ id: "ext", title: "uBlock", enabled: true }],
  ...overrides,
});
const top = (items, title) => items.find((item) => item.title === title);
const find = (items, id) => {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.children && find(item.children, id);
    if (nested) return nested;
  }
};

test("the menu mirrors the macOS menu bar's top-level menus", () => {
  assert.deepEqual(appMenuItems(state()).map((item) => item.title), ["Ardia", "File", "Edit", "View", "Tabs", "Bookmarks", "History", "Extensions", "Window", "Help"]);
});

test("items carry the menu state's checks, disabled commands and titles", () => {
  const items = appMenuItems(state());
  assert.equal(find(items, "setAppearance:dark").checked, true);
  assert.equal(find(items, "setAppearance:light").checked, false);
  assert.equal(find(items, "toggleFullUrl").checked, true);
  assert.equal(find(items, "back").enabled, false);
  assert.equal(find(items, "forward").enabled, true);
  assert.equal(find(items, "togglePin:tile"), undefined);
  assert.equal(find(top(items, "Bookmarks").children, "bookmarkPage").title, "Edit Bookmark…");
  assert.equal(find(top(items, "Tabs").children, "moveTabToProfile:p1").checked, true);
  assert.equal(find(items, "openBookmark:b2").title, "https://ardia.dev");
  assert.equal(find(items, "addFolderToSidebar:f1").enabled, true);
  assert.equal(find(items, "openExtension:ext").title, "uBlock");
});

test("empty lists show a disabled placeholder and single profiles hide profile menus", () => {
  const items = appMenuItems(state({ profiles: [{ id: "p1", title: "Personal", current: true }] }));
  const history = top(items, "History").children;
  assert.deepEqual(history.at(-1), { id: "empty", title: "Empty", enabled: false });
  assert.equal(find(items, "menu:Profiles"), undefined);
  assert.equal(find(items, "menu:New Little Ardia Window in Profile"), undefined);
});

test("items show the effective Linux shortcut", () => {
  const items = appMenuItems(state(), new Map([["newTab", { key: "t", modifiers: ["command", "function"] }]]));
  assert.deepEqual(find(items, "newTab"), { id: "newTab", title: "New Tab", enabled: true, checked: false, key: "t", modifiers: ["command"] });
});

test("choices resolve to commands or window actions and ignore structure rows", () => {
  assert.deepEqual(appMenuChoice("newTab"), { kind: "command", command: "newTab", arg: null });
  assert.deepEqual(appMenuChoice("openBookmark:a:b"), { kind: "command", command: "openBookmark", arg: "a:b" });
  assert.deepEqual(appMenuChoice("window:maximize"), { kind: "window", action: "maximize" });
  assert.deepEqual(appMenuChoice("std:quit:"), { kind: "command", command: "quit", arg: null });
  assert.deepEqual(appMenuChoice("about"), { kind: "about" });
  assert.deepEqual(appMenuChoice("share:via:email"), { kind: "command", command: "share", arg: "via:email" });
  for (const id of ["menu:File", "header:Recent Bookmarks", "folder:f1", "empty", "window:quit"]) assert.equal(appMenuChoice(id), null);
});

const rows = (items, title) => top(items, title).children.map((item) => "separator" in item ? "-" : item.title);

test("the Ardia, File, View and Help menus carry the Mac menu bar's entries in its order", () => {
  const items = appMenuItems(state(), new Map([["std:quit:", { key: "q", modifiers: ["command", "shift"] }], ["newIncognitoWindow", { key: "n", modifiers: ["command", "shift"] }]]));
  assert.deepEqual(rows(items, "Ardia"), ["About Ardia", "-", "Settings…", "Import from Another Browser…", "-", "Quit Ardia"]);
  assert.deepEqual(find(items, "std:quit:"), { id: "std:quit:", title: "Quit Ardia", key: "q", modifiers: ["command", "shift"] });
  const file = rows(items, "File");
  assert.deepEqual(file.slice(0, 4), ["New Tab", "New Tab in Group", "New Window", "New Incognito Window"]);
  assert.deepEqual(file.slice(-5), ["Save Page As…", "Share", "Email Page Location", "Print…", "Print Using System Dialog…"]);
  assert.deepEqual(find(items, "newIncognitoWindow").key, "n");
  assert.deepEqual(top(items, "File").children.find((item) => item.title === "Share").children.map((item) => [item.id, item.title]), [["share:via:copy", "Copy Link"], ["share:via:email", "Email Link"]]);
  const view = top(items, "View").children.map((item) => item.id);
  assert.equal(view.indexOf("toggleSidebarSide"), view.indexOf("toggleSidebar") + 1);
  assert.equal(find(items, "toggleSidebarSide").title, "Sidebar on Right");
  assert.deepEqual(rows(items, "Help"), ["Report a Problem…", "Keyboard Shortcuts", "Tool Tour", "Video Tour", "Release Notes", "-", "Copy Diagnostics"]);
});

test("sharing is disabled where the page can't be shared, and the sidebar side shows its check", () => {
  const items = appMenuItems(state({ disabled: ["share"], checked: ["toggleSidebarSide"] }));
  assert.equal(find(items, "share:via:copy").enabled, false);
  assert.equal(find(items, "share:via:email").enabled, false);
  assert.equal(find(items, "toggleSidebarSide").checked, true);
});

test("leaving entries out never leaves a doubled or dangling separator", () => {
  const items = appMenuItems(state(), new Map(), new Set(["videoTour", "releaseNotes", "copyDiagnostics"]));
  assert.deepEqual(rows(items, "Help"), ["Report a Problem…", "Keyboard Shortcuts", "Tool Tour"]);
});

test("a command the host can't carry out is left out of the menu instead of doing nothing", () => {
  assert.ok(find(appMenuItems(state()), "emailPageLocation"));
  const items = appMenuItems(state(), new Map(), new Set(["emailPageLocation"]));
  assert.equal(find(items, "emailPageLocation"), undefined);
  assert.ok(find(top(items, "File").children, "print"));
});

test("View carries the Mac's full screen entry between the zoom entries and Developer, and its title follows the window", () => {
  const shortcuts = new Map([["std:toggleFullScreen:", { key: String.fromCharCode(0xf70e), modifiers: [] }]]);
  const items = appMenuItems(state(), shortcuts);
  const view = rows(items, "View");
  assert.deepEqual(view.slice(view.indexOf("Zoom Out")), ["Zoom Out", "-", "Enter Full Screen", "-", "Developer"]);
  assert.deepEqual(find(items, "std:toggleFullScreen:"), { id: "std:toggleFullScreen:", title: "Enter Full Screen", key: String.fromCharCode(0xf70e), modifiers: [] });
  assert.equal(find(appMenuItems(state(), shortcuts, new Set(), { fullScreen: true }), "std:toggleFullScreen:").title, "Exit Full Screen");
  assert.deepEqual(appMenuChoice("std:toggleFullScreen:"), { kind: "command", command: "toggleFullScreen", arg: null });
  const without = rows(appMenuItems(state(), shortcuts, new Set(["std:toggleFullScreen:"])), "View");
  assert.deepEqual(without.slice(without.indexOf("Zoom Out")), ["Zoom Out", "-", "Developer"], "a host without full screen leaves the entry out");
});

test("Edit shows the standard editing entries in the Mac's order only while something can take them", () => {
  const bare = rows(appMenuItems(state()), "Edit");
  assert.deepEqual(bare, ["Copy URL", "Copy URL as Markdown", "-", "Find", "AutoFill"]);
  const items = appMenuItems(state(), new Map(), new Set(), { edit: { disabled: new Set(["std:cut:", "std:copy:"]) } });
  assert.deepEqual(rows(items, "Edit"), ["Undo", "Redo", "-", "Cut", "Copy", "Copy URL", "Copy URL as Markdown", "Paste", "Paste and Match Style", "Select All", "-", "Find", "AutoFill"]);
  assert.deepEqual(find(items, "std:undo:"), { id: "std:undo:", title: "Undo", enabled: true, key: "z", modifiers: ["command"] });
  assert.deepEqual(find(items, "std:redo:").modifiers, ["command", "shift"]);
  assert.deepEqual(find(items, "std:pasteAndMatchStyle:").modifiers, ["command", "shift"]);
  assert.equal(find(items, "std:cut:").enabled, false);
  assert.equal(find(items, "std:copy:").enabled, false);
  assert.equal(find(items, "std:paste:").enabled, true);
  assert.equal(find(appMenuItems(state(), new Map(), new Set(), { edit: null }), "std:undo:"), undefined);
  for (const [id, action] of [["std:undo:", "undo"], ["std:redo:", "redo"], ["std:cut:", "cut"], ["std:copy:", "copy"], ["std:paste:", "paste"], ["std:pasteAndMatchStyle:", "pasteAndMatchStyle"], ["std:selectAll:", "selectAll"]])
    assert.deepEqual(appMenuChoice(id), { kind: "edit", action });
  assert.equal(appMenuChoice("std:delete:"), null);
});

test("the Bookmarks menu exports bookmarks and the Window menu minimizes every window with Alt held, as on the Mac", () => {
  const items = appMenuItems(state());
  const bookmarks = top(items, "Bookmarks").children.map((item) => item.id);
  assert.deepEqual(bookmarks.slice(0, 4), ["bookmarkPage", "bookmarkAllTabs", "manageBookmarks", "exportBookmarks"]);
  assert.equal(find(items, "exportBookmarks").title, "Export Bookmarks…");
  assert.deepEqual(appMenuChoice("exportBookmarks"), { kind: "command", command: "exportBookmarks", arg: null });
  const windowMenu = top(items, "Window").children;
  assert.deepEqual(windowMenu.slice(0, 3).map((item) => item.id), ["window:minimize", "window:minimizeAll", "window:maximize"]);
  assert.deepEqual(find(items, "window:minimizeAll"), { id: "window:minimizeAll", title: "Minimize All", modifiers: ["option"], alternate: true });
  assert.deepEqual(appMenuChoice("window:minimizeAll"), { kind: "window", action: "minimizeAll" });
});

test("the Ardia menu checks for updates, or restarts to finish one, only where updates work", () => {
  const ardia = (context) => top(appMenuItems(state(), new Map(), new Set(), context), "Ardia").children.map((item) => item.title ?? "—");
  assert.deepEqual(ardia({}).slice(0, 2), ["About Ardia", "—"]);
  assert.deepEqual(ardia({ updates: "check" }).slice(0, 2), ["About Ardia", "Check for Updates…"]);
  assert.deepEqual(ardia({ updates: "restart" }).slice(0, 2), ["About Ardia", "Restart to Update"]);
  assert.deepEqual(appMenuChoice("checkForUpdates"), { kind: "updates", restart: false });
  assert.deepEqual(appMenuChoice("restartToUpdate"), { kind: "updates", restart: true }, "the item picked decides whether Ardia restarts, not what finished while the menu was open");
});
