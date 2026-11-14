import assert from "node:assert/strict";
import { test } from "node:test";
const { pageCornerRadiusIn, syncPageCorners } = await import("./pageCorners.ts");

const SETTINGS = { tabLayout: "sidebar", sidebarSide: "left", addressBar: "sidebar", compactToolbar: false, autoHideTabs: false, pageFrame: 9 };
function state(settings = {}, window = {}) {
  return {
    windows: { w: { id: "w", kind: "main", profileId: "p", fullScreen: false, ...window } },
    windowOrder: ["w"],
    ui: { focusOrder: ["w"] },
    profiles: { p: { id: "p", name: "Personal" } },
    profileOrder: ["p"],
    windowUi: {},
    settings: { ...SETTINGS, ...settings },
  };
}

const windowsRadius = (settings, window) => pageCornerRadiusIn(state(settings, window), "w", 8, () => 8);

test("on Windows a page that reaches its card's top matches the window's 8 px corners, and goes square with no page frame", () => {
  assert.equal(windowsRadius({}), 8);
  assert.equal(windowsRadius({ pageFrame: 12 }), 8);
  assert.equal(windowsRadius({ addressBar: "toolbar" }, { kind: "small" }), 8);
  assert.equal(windowsRadius({ borderlessMode: true }), 0);
  assert.equal(windowsRadius({ borderlessMode: true, compactToolbar: true }), 0);
  assert.equal(windowsRadius({ pageFrame: 0 }), 0);
  assert.equal(windowsRadius({ pageFrameZeroInFullScreen: true }, { fullScreen: true }), 0);
});

test("on Windows a page below the toolbar or the bookmarks bar stays square, so its top corners cut nothing under the bar", () => {
  assert.equal(windowsRadius({ addressBar: "toolbar" }), 0);
  assert.equal(windowsRadius({ addressBar: "toolbar", compactToolbar: true }), 0);
  assert.equal(windowsRadius({ tabLayout: "top" }), 0);
  assert.equal(windowsRadius({ showBookmarks: true, bookmarksBar: "always" }), 0);
  assert.equal(windowsRadius({ showBookmarks: true, bookmarksBar: "newTab" }), 8);
  assert.equal(windowsRadius({ showBookmarks: false, bookmarksBar: "always" }), 8);
  assert.equal(windowsRadius({ showBookmarks: true, bookmarksBar: "always" }, { kind: "private" }), 8);
});

test("on the Mac the page corner stays concentric with the window", () => {
  assert.equal(pageCornerRadiusIn(state(), "w", null, () => 19), 10);
});

test("the page corner is sent once per change, and again after borderless mode turns on", () => {
  const sends = [];
  const send = (id, radius) => sends.push([id, radius]);
  syncPageCorners(state(), send, 8);
  syncPageCorners(state(), send, 8);
  syncPageCorners(state({ borderlessMode: true }), send, 8);
  syncPageCorners(state({ borderlessMode: false }), send, 8);
  assert.deepEqual(sends, [["w", 8], ["w", 0], ["w", 8]]);
});
