import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SIDEBAR_WIDTH, MIN_WINDOW_WIDTH, SIDEBAR_ICONS_HYSTERESIS, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_PAGE_ROOM, iconsForWidth, shownSidebarWidth, sidebarWidthLimit } = await import("../../lib/windowLayout.ts");
const { sidebarWidthIn } = await import("./shownWidth.ts");
const { followWindowWidth } = await import("./sidebarMode.ts");
const { sidebarModeIn, tabsShownIn } = await import("../browser/model.ts");

const S = () => useBrowser.getState();

test("the sidebar always shows at its saved width, whatever the window's width", () => {
  assert.equal(shownSidebarWidth(DEFAULT_SIDEBAR_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH), SIDEBAR_MAX_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH + 50), SIDEBAR_MAX_WIDTH);
  S().updateSettings({ sidebarWidth: 400 });
  const narrow = S().createWindow({ url: "https://narrow.example/", frame: [80, 80, MIN_WINDOW_WIDTH, 620] });
  assert.equal(sidebarWidthIn(S(), narrow), 400);
  assert.equal(S().settings.sidebarWidth, 400);
});

test("a drag can widen the sidebar only as far as leaves the page its room", () => {
  assert.equal(sidebarWidthLimit(1200), SIDEBAR_MAX_WIDTH);
  assert.equal(sidebarWidthLimit(DEFAULT_SIDEBAR_WIDTH + SIDEBAR_PAGE_ROOM), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthLimit(MIN_WINDOW_WIDTH), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarWidthLimit(undefined), SIDEBAR_MAX_WIDTH);
});

test("a window shows icons once the page would get less than its room beside the full sidebar, and only goes back past the hysteresis", () => {
  const threshold = DEFAULT_SIDEBAR_WIDTH + SIDEBAR_PAGE_ROOM;
  assert.equal(threshold, 600, "600 points with the default width");
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, threshold, false), false);
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, threshold - 1, false), true);
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, threshold, true), true, "a resize resting at the threshold doesn't flap back");
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, threshold + SIDEBAR_ICONS_HYSTERESIS - 1, true), true);
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, threshold + SIDEBAR_ICONS_HYSTERESIS, true), false);
  assert.equal(iconsForWidth(300, 709, false), true, "a wider saved sidebar needs a wider window");
  assert.equal(iconsForWidth(300, 710, false), false);
  assert.equal(iconsForWidth(DEFAULT_SIDEBAR_WIDTH, undefined, true), true, "no width yet keeps what it shows");
});

test("a Full window too narrow for its sidebar shows icons without touching the saved setting, and a Hidden one stays hidden", () => {
  S().hydrate({});
  const id = S().createWindow({ url: "https://example.com/", frame: [0, 0, 1200, 800] });
  followWindowWidth(id, 1200);
  assert.equal(sidebarModeIn(S(), id), "full");
  followWindowWidth(id, 520);
  assert.equal(sidebarModeIn(S(), id), "icons");
  assert.equal(tabsShownIn(S(), id), false);
  assert.equal(S().settings.autoHideTabs, false);
  assert.equal(S().settings.collapsedSidebar, "hidden");
  S().toggleSidebar(id);
  assert.equal(sidebarModeIn(S(), id), "hidden", "⌘S still goes to the chosen collapsed mode");
  S().toggleSidebar(id);
  assert.equal(sidebarModeIn(S(), id), "icons", "and back to Full, which this width shows as icons");
  followWindowWidth(id, 610);
  assert.equal(sidebarModeIn(S(), id), "icons", "inside the hysteresis band");
  followWindowWidth(id, 640);
  assert.equal(sidebarModeIn(S(), id), "full");
  S().toggleTabLayout(id);
  followWindowWidth(id, 520);
  assert.equal(sidebarModeIn(S(), id), "full", "tabs across the top never turn into icons");
});

test("a click on the edge of a 500 pt window's floating sidebar never changes the saved 400 pt width", async () => {
  const { resizeGesture } = await import("../../components/sidebar/resizeDrag.ts");
  const { sidebarResizeBounds, widthToSave } = await import("./shownWidth.ts");
  const saved = [];
  const gesture = resizeGesture({ current: { ...sidebarResizeBounds(false, 500), direction: 1, saved: () => 400, pointerFromEdge: () => 0, onLive: () => {}, onCommit: (w, dragged) => { const kept = widthToSave(w, dragged); if (kept !== null) saved.push(kept); } } });
  gesture.onPanResponderGrant({ nativeEvent: {} });
  gesture.onPanResponderRelease({}, { dx: 0 });
  assert.deepEqual(saved, []);
  assert.deepEqual(sidebarResizeBounds(false, 500), { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }, "the floating sidebar isn't held to the page's room");
  assert.deepEqual(sidebarResizeBounds(true, 600), { min: SIDEBAR_MIN_WIDTH, max: 190 });
});
