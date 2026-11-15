import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SIDEBAR_WIDTH, MIN_WINDOW_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, shownSidebarWidth, sidebarWidthLimit } = await import("../../lib/windowLayout.ts");
const { forgetWindowLayoutWidth, keptSidebarWidth, setWindowLayoutWidth, sidebarWidthIn } = await import("./shownWidth.ts");

const S = () => useBrowser.getState();

test("at the window's minimum width the sidebar shows at most its default width, and the page keeps the rest", () => {
  assert.equal(sidebarWidthLimit(MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(DEFAULT_SIDEBAR_WIDTH, MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, 600), 290);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, 720), SIDEBAR_MAX_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MIN_WIDTH, MIN_WINDOW_WIDTH), SIDEBAR_MIN_WIDTH);
  assert.equal(shownSidebarWidth(300, undefined), 300);
  assert.equal(sidebarWidthLimit(400), SIDEBAR_MIN_WIDTH);
});

test("a window's live width caps its sidebar while the saved width stays, and other windows keep theirs", () => {
  S().updateSettings({ sidebarWidth: 400 });
  const narrow = S().createWindow({ url: "https://narrow.example/", frame: [80, 80, 500, 620] });
  const wide = S().createWindow({ url: "https://wide.example/", frame: [80, 80, 1200, 800] });
  assert.equal(sidebarWidthIn(S(), narrow), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthIn(S(), wide), 400);
  setWindowLayoutWidth(wide, 560);
  assert.equal(sidebarWidthIn(S(), wide), 250, "the live layout width wins over the last reported frame");
  forgetWindowLayoutWidth(wide);
  assert.equal(sidebarWidthIn(S(), wide), 400);
  assert.equal(S().settings.sidebarWidth, 400);
});

test("a drag that ends at the window's limit keeps the wider saved width, and a narrower drag is saved", () => {
  assert.equal(keptSidebarWidth(190, 190, 400), 400);
  assert.equal(keptSidebarWidth(175, 190, 400), 175);
  assert.equal(keptSidebarWidth(250, 290, 190), 250);
  assert.equal(keptSidebarWidth(290, 290, 190), 290);
});
