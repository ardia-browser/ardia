import assert from "node:assert/strict";
import { test } from "node:test";
import { DROP_SIDES, PREVIEW, zoneHit, zoneRect } from "./splitDrop.ts";
import { clampHandleOffset, handlePosition, paneAtPoint } from "./paneDrag.ts";

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("all four split drop zones stay inside the pane and never overlap at rest, grown or active", () => {
  for (const pane of [
    { x: 0, y: 0, width: 1200, height: 800 },
    { x: 0, y: 0, width: 600, height: 800 },
    { x: 0, y: 400, width: 1200, height: 390 },
    { x: 100, y: 50, width: 480, height: 360 },
  ]) {
    for (const stage of ["rest", "grown"]) {
      const rects = DROP_SIDES.map((side) => [side, zoneRect(pane, side, stage)]);
      for (const [side, r] of rects) {
        assert.ok(r.x >= pane.x && r.y >= pane.y, `${side} ${stage} inside top-left`);
        assert.ok(r.x + r.width <= pane.x + pane.width + 0.01 && r.y + r.height <= pane.y + pane.height + 0.01, `${side} ${stage} inside bottom-right`);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          assert.equal(overlaps(rects[i][1], rects[j][1]), false, `${rects[i][0]} and ${rects[j][0]} overlap in ${stage}`);
        }
      }
    }
    for (const activeSide of DROP_SIDES) {
      const home = zoneRect(pane, activeSide, "grown");
      const active = zoneRect(pane, activeSide, "active", home.x + home.width / 2, home.y + home.height / 2);
      for (const other of DROP_SIDES) {
        if (other === activeSide) continue;
        assert.equal(overlaps(active, zoneRect(pane, other, "grown")), false, `active ${activeSide} overlaps grown ${other}`);
      }
    }
  }
});

test("top and bottom active zones lean vertically toward the pointer while staying within pane bounds", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const topHigh = zoneRect(pane, "top", "active", 500, 10);
  const topLow = zoneRect(pane, "top", "active", 500, 300);
  assert.ok(topLow.y > topHigh.y);
  assert.ok(topHigh.y >= pane.y);
  const bottomHigh = zoneRect(pane, "bottom", "active", 500, 500);
  const bottomLow = zoneRect(pane, "bottom", "active", 500, 790);
  assert.ok(bottomLow.y > bottomHigh.y);
  assert.ok(bottomLow.y + bottomLow.height <= pane.y + pane.height);
});

test("zoneHit detects left, right, top and bottom edges and switches immediately when the pointer enters another zone", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(zoneHit(panes, 120, 400, null), { tabId: "t1", side: "left" });
  assert.deepEqual(zoneHit(panes, 880, 400, null), { tabId: "t1", side: "right" });
  assert.deepEqual(zoneHit(panes, 500, 80, null), { tabId: "t1", side: "top" });
  assert.deepEqual(zoneHit(panes, 500, 720, null), { tabId: "t1", side: "bottom" });
  assert.equal(zoneHit(panes, 500, 400, null), null);
  assert.deepEqual(zoneHit(panes, 500, 80, { tabId: "t1", side: "left" }), { tabId: "t1", side: "top" });
  const grownTop = zoneRect(pane, "top", "grown");
  assert.deepEqual(zoneHit(panes, 500, grownTop.y + grownTop.height + PREVIEW.height / 2 - 5, { tabId: "t1", side: "top" }), { tabId: "t1", side: "top" });
});

test("pane drag helpers place the move handle at the pane top-left, find target panes in 2D and clamp to card bounds", () => {
  const panes = {
    a: { x: 0, y: 0, width: 500, height: 395 },
    b: { x: 0, y: 404, width: 500, height: 396 },
    c: { x: 509, y: 0, width: 491, height: 800 },
  };
  assert.deepEqual(handlePosition(panes.b, 38, 8), { left: 8, top: 450 });
  assert.equal(paneAtPoint(panes, 100, 100, "a"), null);
  assert.equal(paneAtPoint(panes, 100, 500, "a"), "b");
  assert.equal(paneAtPoint(panes, 700, 200, "a"), "c");
  assert.equal(paneAtPoint(panes, 504, 200, "a"), null);
  assert.deepEqual(clampHandleOffset(-20, 900, { width: 1000, height: 800 }, 22), { left: 0, top: 778 });
});
