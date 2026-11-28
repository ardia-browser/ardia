import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { clearlyOverflows, DOCK_SLACK, dockedAfter, pageLayout, rowPitch } = await import("./pageLayout.ts");

const ROW = 41;
const gridHeight = (count) => Math.ceil(count / 3) * ROW;
const at = (overrides) =>
  pageLayout({ tiles: 3, previewed: 3, dockRoom: 300, gridHeight, dragging: false, fixedBeforeDrag: true, ...overrides });

test("tiles that fit 40 % of the sidebar stay fixed above the list; a taller dock scrolls with it", () => {
  assert.equal(at({ tiles: 3 }).dockFixed, true);
  assert.equal(at({ tiles: 21, dockRoom: 287 }).dockFixed, true);
  assert.equal(at({ tiles: 24, dockRoom: 287 }).dockFixed, false);
  assert.equal(at({ tiles: 0, dockRoom: -10 }).dockFixed, true);
  assert.equal(at({ tiles: 3, dockRoom: Infinity }).dockFixed, true);
});

test("the fixed or scrolling choice is frozen for a drag", () => {
  assert.equal(at({ tiles: 24, dockRoom: 287, dragging: true, fixedBeforeDrag: true }).dockFixed, true);
  assert.equal(at({ tiles: 3, dragging: true, fixedBeforeDrag: false }).dockFixed, false);
});

test("a drag that previews more tiles than fit caps the dock at its room", () => {
  assert.equal(at({ tiles: 3, previewed: 23, dragging: true, fixedBeforeDrag: true }).capped, true);
  assert.equal(at({ tiles: 3, previewed: 21, dragging: true, fixedBeforeDrag: true }).capped, false);
  assert.equal(at({ tiles: 3, previewed: 23, dragging: false }).capped, false);
  assert.equal(at({ tiles: 30, previewed: 40, dragging: true, fixedBeforeDrag: false }).capped, false);
});

test("New Tab docks when less than its slack is left under it, and comes back once the docked list leaves any room", () => {
  assert.equal(dockedAfter(false, DOCK_SLACK - 1), true);
  assert.equal(dockedAfter(false, DOCK_SLACK), false);
  assert.equal(dockedAfter(false, 0), true);
  assert.equal(dockedAfter(true, 0), true);
  assert.equal(dockedAfter(true, 0.5), true);
  assert.equal(dockedAfter(true, 1), false);
  assert.equal(dockedAfter(true, 400), false);
});

test("an expanded Playing now card's growth counts as room, and an expansion that fills the room leaves the dock as it was", () => {
  assert.equal(dockedAfter(true, 0, 54), true);
  assert.equal(dockedAfter(false, 0, 54), false);
  assert.equal(dockedAfter(true, 10, 54), false);
  assert.equal(dockedAfter(false, 10, 54), false);
});

test("a page starts with New Tab docked only when its rows clearly overflow it, so a short or borderline list never flips at launch", () => {
  const height = 600;
  const rowsFor = (px) => Math.ceil(px / rowPitch());
  assert.equal(clearlyOverflows(200, height), true, "a 200-tab list starts docked");
  assert.equal(clearlyOverflows(rowsFor(height * 2) + 1, height), true);
  assert.equal(clearlyOverflows(rowsFor(height), height), false, "a list about one page tall waits for its layout");
  assert.equal(clearlyOverflows(rowsFor(height * 2) - 1, height), false);
  assert.equal(clearlyOverflows(0, height), false);
  assert.equal(clearlyOverflows(500, 0), false, "no height yet means no guess");
});

test("the sidebar page makes its first dock guess from the entries once, without subscribing to them", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(!dockGuessed && canDock && height > 0\) \{/);
  assert.match(page, /clearlyOverflows\(sidebarListLengthNow\(windowId, profileId\), height\)/);
});

test("the dock reads its free space from the filler's child, whose frame moves only when that space changes, not with every row added", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<ContextMenuArea style=\{\{ flex: 1 \}\} onLayout=\{onSlack\}/);
  assert.doesNotMatch(page, /<View key=\{[^}]*\}[^>]*onLayout=\{onSlack\}/);
});

test("a free-space reading that arrives before the sidebar has a height is kept and applied once it does", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /slack\.current = e\.nativeEvent\.layout\.height;\n\s*applySlack\(\);/);
  assert.match(page, /useEffect\(applySlack, \[height > 0, canDock, resting/);
});

test("rows leaving under the pointer don't shorten the list or undock the New Tab row until the pointer leaves", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /minHeight: hold\.minHeight/);
  assert.match(page, /if \(next \|\| !hold\.holding\(\)\) dock\(next\);/);
  assert.match(page, /active: current && !resting/);
  assert.match(page, /showsHorizontalScrollIndicator=\{false\}/, "no legacy horizontal scroller margin under the list, so the list fills the scroll view");
});

test("no sidebar page mounts past its warm first screen while it isn't the shown one, during a hold included", () => {
  const sidebar = readFileSync(new URL("./SidebarPages.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /rows=\{page\.id === shown \? undefined : capRows\}/);
  assert.doesNotMatch(sidebar, /entriesThrough|throughActive|pageRowsCap/, "nothing pre-mounts down to a selected tab");
});
