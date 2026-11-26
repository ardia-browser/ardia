import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { shortcutSearchHit } = await import("./shortcutSearch.ts");
const { commandBarKeywords } = await import("../../state/omnibox/barActions.ts");
const { commandTitle } = await import("../../state/commands/commandCatalog.ts");

const autoHideTabs = (query) => shortcutSearchHit(query, [commandTitle("toggleSidebar"), "View", "⌘S", ""], commandBarKeywords("toggleSidebar"));

test("Keyboard Shortcuts finds Auto-Hide Tabs by the words the command bar knows it by", () => {
  assert.equal(commandTitle("toggleSidebar"), "Auto-Hide Tabs");
  for (const query of ["sidebar", "toggle sidebar", "hide sidebar", "show sidebar", "Hide Sidebar", "focus mode"]) assert.equal(autoHideTabs(query), "keyword", query);
});

test("a command's own title, menu and keys still match first, and unrelated words don't", () => {
  assert.equal(autoHideTabs("auto-hide"), "named");
  assert.equal(autoHideTabs("view tabs"), "named");
  assert.equal(autoHideTabs("⌘S"), "named");
  assert.equal(autoHideTabs("view sidebar"), "keyword");
  assert.equal(autoHideTabs("bookmarks"), null);
  assert.equal(shortcutSearchHit("sidebar", ["Print…", "File", "⌘P"], commandBarKeywords("print")), null);
});

test("the command bar's keywords are listed per action, with an action's argument kept apart", () => {
  assert.deepEqual(commandBarKeywords("setAppearance:dark"), ["dark mode"]);
  assert.deepEqual(commandBarKeywords("setAppearance"), []);
  assert.ok(commandBarKeywords("togglePin").includes("pin tab"));
  assert.ok(commandBarKeywords("togglePin:row").includes("pinned tabs"));
  assert.deepEqual(commandBarKeywords("no-such-command"), []);
});
