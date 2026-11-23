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
  assert.deepEqual(handleOrigin({ x: 408, y: 0, width: 400, height: 700 }, 42, 8), { x: 416, y: 50 });
});

test("resolveMoveTarget ignores micro-movements, hits any pane directly, holds outer targets past edges and gaps, and assists rightward pulls", () => {
  const startA = { x: 19, y: 61 };
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 2, 1), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 50, 0), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 100, 4), "b");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 450, 0), "b");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 793, 0), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 850, 0), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 850, -90), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 1400, 0), "c");
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, -120, 0), null);
  assert.equal(resolveMoveTarget(row, rowPanes, "a", startA, 0, -90), null);

  const startB = { x: 427, y: 61 };
  assert.equal(resolveMoveTarget(row, rowPanes, "b", startB, -35, 0), "a");
  assert.equal(resolveMoveTarget(row, rowPanes, "b", startB, 100, 0), "c");

  const startC = { x: 835, y: 61 };
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, -35, 0), "b");
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, -460, 0), "a");
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, -950, 0), "a");
  assert.equal(resolveMoveTarget(row, rowPanes, "c", startC, 120, 0), null);
});

test("resolveMoveTarget handles vertical and nested stacked splits", () => {
  const column = { orientation: "vertical", slots: [{ size: 0.5, tabId: "top" }, { size: 0.5, tabId: "bottom" }] };
  const panes = { top: { x: 0, y: 0, width: 800, height: 340 }, bottom: { x: 0, y: 348, width: 800, height: 340 } };
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 61 }, 120, 0), null);
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 61 }, 0, 100), "bottom");
  assert.equal(resolveMoveTarget(column, panes, "top", { x: 19, y: 61 }, 0, 800), "bottom");
  assert.equal(resolveMoveTarget(column, panes, "bottom", { x: 19, y: 409 }, 0, -70), "top");

  const stacked = { orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  const stackedPanes = {
    a: { x: 0, y: 0, width: 400, height: 700 },
    b: { x: 408, y: 0, width: 400, height: 346 },
    c: { x: 408, y: 354, width: 400, height: 346 },
  };
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "a", { x: 19, y: 61 }, 450, 420), "c");
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "c", { x: 427, y: 415 }, -200, 0), "a");
  assert.equal(resolveMoveTarget(stacked, stackedPanes, "b", { x: 427, y: 61 }, 0, 340), "c");
});

test("moveHandleTooltip formats shortcut hints cleanly", () => {
  assert.equal(moveHandleTooltip("⌃⌥←", "⌃⌥→"), "Drag to move split pane (⌃⌥← / ⌃⌥→)");
  assert.equal(moveHandleTooltip("⌃⌥←", undefined), "Drag to move split pane (⌃⌥←)");
  assert.equal(moveHandleTooltip(undefined, undefined), "Drag to move split pane");
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

test("split move handle stays hidden until hovered", () => {
  const handlesSource = readFileSync(new URL("./SplitMoveHandles.tsx", import.meta.url), "utf8");
  assert.match(handlesSource, /const visible = \(hovered \|\| draggingThis\) && !obscured && !draggingAny;/);
  assert.match(handlesSource, /usePresence\(visible \? true : null/);
  assert.doesNotMatch(handlesSource, /restOpacity|activeOpacity/);
});
