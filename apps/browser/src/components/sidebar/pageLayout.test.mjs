import assert from "node:assert/strict";
import { test } from "node:test";
const { DOCK_SLACK, dockedAfter, pageLayout } = await import("./pageLayout.ts");

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
