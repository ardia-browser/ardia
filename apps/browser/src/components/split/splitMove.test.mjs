import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
const { handleOrigin, moveHandleTooltip, paneTopChrome, resolveMoveTarget } = await import("./splitMove.ts");

const row = { orientation: "horizontal", slots: [{ size: 1 / 3, tabId: "a" }, { size: 1 / 3, tabId: "b" }, { size: 1 / 3, tabId: "c" }] };
const rowPanes = {
  a: { x: 0, y: 0, width: 400, height: 700 },
  b: { x: 408, y: 0, width: 400, height: 700 },
  c: { x: 816, y: 0, width: 400, height: 700 },
};

test("paneTopChrome clears pane toolbars, auto-hide strips, developer bars, plugin page bars, and share bars", () => {
  assert.equal(paneTopChrome({ chrome: { kind: "pane", autoHide: false }, toolbarHeight: 42, collapsed: false, topBarHeight: 0 }), 42);
  assert.equal(paneTopChrome({ chrome: { kind: "pane", autoHide: true }, toolbarHeight: 42, collapsed: true, topBarHeight: 0 }), 20);
  assert.equal(paneTopChrome({ chrome: { kind: "pane", autoHide: true }, toolbarHeight: 42, collapsed: false, topBarHeight: 0, shareBarHeight: 38 }), 80);
  assert.equal(paneTopChrome({ chrome: { kind: "none" }, toolbarHeight: 42, collapsed: false, topBarHeight: 0 }), 0);
  assert.equal(paneTopChrome({ chrome: { kind: "none" }, toolbarHeight: 42, collapsed: false, topBarHeight: 36 }), 36);
  assert.equal(paneTopChrome({ chrome: { kind: "none" }, toolbarHeight: 42, collapsed: false, topBarHeight: 32, shareBarHeight: 38 }), 70);
});

test("handleOrigin insets from the pane top-left below top chrome", () => {
  const rect = { x: 408, y: 0, width: 400, height: 700 };
  assert.deepEqual(handleOrigin(rect, 0), { x: 416, y: 8 });
  assert.deepEqual(handleOrigin(rect, 36), { x: 416, y: 44 });
});

test("resolveMoveTarget ignores micro-movements, hits any pane directly, holds outer targets past edges and gaps, and assists directional pulls", () => {
  const startA = { x: 19, y: 19 };
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 2, 1), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, -50, 0), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 120, 0), "b");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 850, 0), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 1400, 0), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, -400, 0), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 0, -90), null);

  const startB = { x: 427, y: 19 };
  assert.equal(resolveMoveTarget(row, rowPanes, "b", startB, -100, 0), "a");
  assert.equal(resolveMoveTarget(row, rowPanes, "b", startB, 100, 0), "c");

  const startC = { x: 835, y: 19 };
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, -100, 0), "b");
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, -850, 0), "a");
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, 120, 0), null);
});

test("resolveMoveTarget handles vertical and nested stacked splits", () => {
  const column = { orientation: "vertical", slots: [{ size: 0.5, tabId: "top" }, { size: 0.5, tabId: "bottom" }] };
  const panes = { top: { x: 0, y: 0, width: 800, height: 340 }, bottom: { x: 0, y: 348, width: 800, height: 340 } };
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 19 }, 120, 0), null);
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 19 }, 0, 100), "bottom");
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 19 }, 0, 800), "bottom");
  assert.equal(resolveMoveTarget(column, panes, "bottom", { x: 19, y: 367 }, 0, -70), "top");

  const stacked = { orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  const stackedPanes = {
    a: { x: 0, y: 0, width: 400, height: 700 },
    b: { x: 408, y: 0, width: 400, height: 346 },
    c: { x: 408, y: 354, width: 400, height: 346 },
  };
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "a", { x: 19, y: 19 }, 500, 420), "c");
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "c", { x: 427, y: 373 }, -300, 0), "a");
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "b", { x: 427, y: 19 }, 0, 340), "c");
});

test("moveHandleTooltip adapts shortcut hints to horizontal, vertical, and stacked split topologies", () => {
  const hints = { movePaneLeft: "⌃⌥←", movePaneRight: "⌃⌥→", movePaneUp: "⌃⌥↑", movePaneDown: "⌃⌥↓" };
  const horizontal = { orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, tabId: "b" }] };
  const vertical = { orientation: "vertical", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, tabId: "b" }] };
  const stacked = { orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  assert.equal(moveHandleTooltip(horizontal, hints), "Drag to move split pane · Right-click for actions (⌃⌥← / ⌃⌥→)");
  assert.equal(moveHandleTooltip(vertical, hints), "Drag to move split pane · Right-click for actions (⌃⌥↑ / ⌃⌥↓)");
  assert.equal(moveHandleTooltip(stacked, hints), "Drag to move split pane · Right-click for actions (⌃⌥← / ⌃⌥→ / ⌃⌥↑ / ⌃⌥↓)");
  assert.equal(moveHandleTooltip(horizontal, {}), "Drag to move split pane · Right-click for actions");
});

test("split move icon loads the SVG directly with no PNG fallbacks", () => {
  const svgUrl = new URL("../../../assets/split-move.svg", import.meta.url);
  assert.ok(existsSync(svgUrl));
  for (const png of ["split-move.png", "split-move@2x.png", "split-move@3x.png"]) {
    assert.equal(existsSync(new URL(`../../../assets/${png}`, import.meta.url)), false, `${png} should not exist`);
  }
  const iconSource = readFileSync(new URL("./SplitMoveIcon.tsx", import.meta.url), "utf8");
  assert.match(iconSource, /split-move\.svg/);
  assert.doesNotMatch(iconSource, /\.png/);
});

test("split move handle renders on hover at the top-left, opens the split actions menu on right-click, and cancels on Escape", () => {
  const handlesSource = readFileSync(new URL("./SplitMoveHandles.tsx", import.meta.url), "utf8");
  assert.match(handlesSource, /handleOrigin\(rect, topChrome\)/);
  assert.match(handlesSource, /const visible = \(hovered \|\| draggingThis\) && !obscured && !draggingAny;/);
  assert.match(handlesSource, /<ContextMenuArea[\s\S]*captureDescendants[\s\S]*onContextMenu=\{openMenu\}/);
  assert.match(handlesSource, /showSplitMenu\(cur\.tabId\)/);
  assert.match(handlesSource, /cancelSplitMoveDrag\(true,/);
  assert.equal(existsSync(new URL("./SplitMoveButton.tsx", import.meta.url)), false);
});
