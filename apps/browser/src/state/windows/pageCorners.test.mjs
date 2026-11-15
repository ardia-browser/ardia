import assert from "node:assert/strict";
import { test } from "node:test";
const { pageRoundingIn, syncPageCorners } = await import("./pageCorners.ts");

const SETTINGS = { tabLayout: "sidebar", sidebarSide: "left", addressBar: "sidebar", compactToolbar: false, autoHideTabs: false, pageFrame: 9 };
function state(settings = {}, window = {}, splits = {}) {
  return {
    windows: { w: { id: "w", kind: "main", profileId: "p", fullScreen: false, activeTabIds: { p: "a" }, ...window } },
    tabs: { a: { id: "a", windowId: "w", url: "https://a.test" }, b: { id: "b", windowId: "w", url: "https://b.test" }, c: { id: "c", windowId: "w", url: "https://c.test" } },
    splits,
    windowOrder: ["w"],
    ui: { focusOrder: ["w"] },
    profiles: { p: { id: "p", name: "Personal" } },
    profileOrder: ["p"],
    windowUi: {},
    settings: { ...SETTINGS, ...settings },
  };
}

const windowsRounding = (settings, window, splits) => pageRoundingIn(state(settings, window, splits), "w", 8, () => 8);
const ACTIVE_SPLIT = { s: { id: "s", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, tabId: "b" }] } };
const OTHER_SPLIT = { s: { id: "s", slots: [{ size: 0.5, tabId: "b" }, { size: 0.5, tabId: "c" }] } };
const ALL_ROUND = { radius: 8, corners: [8, 8, 8, 8] };
const BOTTOM_ROUND = { radius: 0, corners: [0, 0, 8, 8] };
const SQUARE = { radius: 0, corners: [0, 0, 0, 0] };

test("on Windows a page that reaches its card's top rounds all four corners to the window's 8 px, and goes square with no page frame", () => {
  assert.deepEqual(windowsRounding({}), ALL_ROUND);
  assert.deepEqual(windowsRounding({ pageFrame: 12 }), ALL_ROUND);
  assert.deepEqual(windowsRounding({ addressBar: "toolbar" }, { kind: "small" }), ALL_ROUND);
  assert.deepEqual(windowsRounding({ borderlessMode: true }), SQUARE);
  assert.deepEqual(windowsRounding({ borderlessMode: true, compactToolbar: true }), SQUARE);
  assert.deepEqual(windowsRounding({ pageFrame: 0 }), SQUARE);
  assert.deepEqual(windowsRounding({ pageFrameZeroInFullScreen: true }, { fullScreen: true }), SQUARE);
});

test("on Windows a page below the toolbar or the bookmarks bar rounds only its bottom corners, and an engine that can't round single corners keeps it square", () => {
  assert.deepEqual(windowsRounding({ addressBar: "toolbar" }), BOTTOM_ROUND);
  assert.deepEqual(windowsRounding({ addressBar: "toolbar", compactToolbar: true }), BOTTOM_ROUND);
  assert.deepEqual(windowsRounding({ tabLayout: "top" }), BOTTOM_ROUND);
  assert.deepEqual(windowsRounding({ showBookmarks: true, bookmarksBar: "always" }), BOTTOM_ROUND);
  assert.deepEqual(windowsRounding({ showBookmarks: true, bookmarksBar: "newTab" }), ALL_ROUND);
  assert.deepEqual(windowsRounding({ showBookmarks: false, bookmarksBar: "always" }), ALL_ROUND);
  assert.deepEqual(windowsRounding({ showBookmarks: true, bookmarksBar: "always" }, { kind: "private" }), ALL_ROUND);
  assert.deepEqual(windowsRounding({ addressBar: "toolbar", borderlessMode: true }), SQUARE);
});

test("on Windows Split View hides the bookmarks bar, so a split's panes round all four corners again", () => {
  const bar = { showBookmarks: true, bookmarksBar: "always" };
  assert.deepEqual(windowsRounding(bar, {}, ACTIVE_SPLIT), ALL_ROUND);
  assert.deepEqual(windowsRounding(bar, {}, OTHER_SPLIT), BOTTOM_ROUND);
  assert.deepEqual(windowsRounding({ ...bar, addressBar: "toolbar" }, {}, ACTIVE_SPLIT), BOTTOM_ROUND);
});

test("on the Mac the page corner stays concentric with the window", () => {
  assert.equal(pageRoundingIn(state(), "w", null, () => 19).radius, 10);
});

test("the page's rounding is sent once per change, and again when the layout or borderless mode changes it", () => {
  const sends = [];
  const send = (id, rounding) => sends.push([id, rounding]);
  syncPageCorners(state(), send, 8);
  syncPageCorners(state(), send, 8);
  syncPageCorners(state({ addressBar: "toolbar" }), send, 8);
  syncPageCorners(state({ addressBar: "toolbar", borderlessMode: true }), send, 8);
  syncPageCorners(state({ addressBar: "toolbar" }), send, 8);
  assert.deepEqual(sends, [
    ["w", ALL_ROUND],
    ["w", BOTTOM_ROUND],
    ["w", SQUARE],
    ["w", BOTTOM_ROUND],
  ]);
});
