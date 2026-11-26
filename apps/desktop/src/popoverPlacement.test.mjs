import assert from "node:assert/strict";
import test from "node:test";
import { placePopover, snapToDevice } from "./popoverPlacement.ts";

const area = { x: 0, y: 0, width: 1000, height: 700 };

test("a popover sits below its anchor, centred, with the arrow on the anchor's centre", () => {
  const placed = placePopover({ anchor: { x: 400, y: 100, width: 40, height: 20 }, size: { width: 200, height: 150 }, area });
  assert.deepEqual(placed.rect, { x: 320, y: 124, width: 200, height: 150 });
  assert.equal(placed.side, "bottom");
  assert.equal(placed.flipped, false);
  assert.equal(placed.clamped, false);
  assert.equal(placed.arrowOffset, 100);
});

test("it flips to the side with room and stays put when neither side has more", () => {
  const flipped = placePopover({ anchor: { x: 400, y: 600, width: 40, height: 20 }, size: { width: 200, height: 150 }, area });
  assert.equal(flipped.side, "top");
  assert.equal(flipped.flipped, true);
  assert.equal(flipped.rect.y, 600 - 4 - 150);
  const right = placePopover({ anchor: { x: 900, y: 300, width: 20, height: 20 }, size: { width: 200, height: 100 }, area, side: "right" });
  assert.equal(right.side, "left");
  assert.equal(right.rect.x, 900 - 4 - 200);
  const cramped = placePopover({ anchor: { x: 0, y: 300, width: 10, height: 10 }, size: { width: 100, height: 900 }, area, side: "bottom" });
  assert.equal(cramped.flipped, false);
});

test("it clamps into the area with a margin, keeps the arrow on the anchor and shrinks when too big", () => {
  const edge = placePopover({ anchor: { x: 980, y: 100, width: 16, height: 16 }, size: { width: 200, height: 100 }, area });
  assert.equal(edge.rect.x, 1000 - 8 - 200);
  assert.equal(edge.clamped, true);
  assert.equal(edge.arrowOffset, 988 - 792);
  const huge = placePopover({ anchor: { x: 10, y: 10, width: 10, height: 10 }, size: { width: 2000, height: 100 }, area });
  assert.equal(huge.rect.x, 8);
  assert.equal(huge.rect.width, 1000 - 16);
});

test("start and end alignment line up with the anchor's edges", () => {
  const anchor = { x: 300, y: 100, width: 80, height: 20 };
  assert.equal(placePopover({ anchor, size: { width: 200, height: 50 }, area, align: "start" }).rect.x, 300);
  assert.equal(placePopover({ anchor, size: { width: 200, height: 50 }, area, align: "end" }).rect.x, 180);
});

test("an area off the window origin, as the screen work area is, is respected", () => {
  const work = { x: -200, y: -50, width: 1920, height: 1080 };
  const placed = placePopover({ anchor: { x: -150, y: 900, width: 20, height: 20 }, size: { width: 200, height: 200 }, area: work });
  assert.equal(placed.rect.x, -192);
  assert.equal(placed.side, "top");
});

test("edges snap to device pixels at fractional scales", () => {
  assert.equal(snapToDevice(10.3, 2), 10.5);
  assert.equal(snapToDevice(10.3, 1), 10);
  assert.equal(snapToDevice(10.3, 0), 10);
  const placed = placePopover({ anchor: { x: 100.13, y: 50.37, width: 33.3, height: 20 }, size: { width: 101, height: 80 }, area, scale: 1.5 });
  for (const value of Object.values(placed.rect)) assert.equal(Math.abs(value * 1.5 - Math.round(value * 1.5)) < 1e-9, true);
});

test("a work area smaller than twice the margin gives a zero-sized rect inside it, never negative", () => {
  const placed = placePopover({ anchor: { x: 2, y: 2, width: 2, height: 2 }, size: { width: 200, height: 150 }, area: { x: 0, y: 0, width: 10, height: 10 } });
  assert.ok(placed.rect.width >= 0 && placed.rect.height >= 0);
  assert.ok(placed.rect.x >= 0 && placed.rect.x + placed.rect.width <= 10);
  assert.ok(placed.rect.y >= 0 && placed.rect.y + placed.rect.height <= 10);
  const empty = placePopover({ anchor: { x: 0, y: 0, width: 0, height: 0 }, size: { width: 10, height: 10 }, area: { x: 0, y: 0, width: 0, height: 0 } });
  assert.deepEqual(empty.rect, { x: 0, y: 0, width: 0, height: 0 });
});

test("non-finite anchors, sizes, margins and scales never reach the result", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const placed = placePopover({ anchor: { x: bad, y: bad, width: bad, height: 20 }, size: { width: bad, height: 100 }, area, margin: bad, gap: bad, scale: bad });
    for (const value of [...Object.values(placed.rect), placed.arrowOffset]) assert.ok(Number.isFinite(value), `${bad} -> ${JSON.stringify(placed)}`);
    assert.ok(placed.rect.width >= 0 && placed.rect.height >= 0);
  }
});

test("device-pixel snapping keeps every edge inside a fractional work area, negative origins included", () => {
  const work = { x: -100.3, y: -40.7, width: 300.55, height: 200.45 };
  for (const scale of [1, 1.25, 1.5, 2]) for (const anchorX of [-120, -50.2, 0, 150.9, 400]) {
    const placed = placePopover({ anchor: { x: anchorX, y: 30.3, width: 17.7, height: 10 }, size: { width: 180.4, height: 90.6 }, area: work, scale });
    const { x, y, width, height } = placed.rect;
    assert.ok(x >= work.x + 8 - 1e-9 && x + width <= work.x + work.width - 8 + 1e-9, `x ${scale} ${anchorX} ${JSON.stringify(placed.rect)}`);
    assert.ok(y >= work.y + 8 - 1e-9 && y + height <= work.y + work.height - 8 + 1e-9, `y ${scale} ${anchorX} ${JSON.stringify(placed.rect)}`);
    for (const value of [x, y, x + width, y + height]) assert.ok(Math.abs(value * scale - Math.round(value * scale)) < 1e-6);
  }
  assert.ok(placePopover({ anchor: { x: -90, y: 0, width: 10, height: 10 }, size: { width: 50, height: 50 }, area: work, align: "start" }).rect.x < 0);
});

test("a fractional work area narrower than a device pixel keeps its zero-sized rect inside the area", () => {
  for (const scale of [1, 1.5, 2]) {
    const work = { x: 10.2, y: 20.1, width: 0.3, height: 0.25 };
    const placed = placePopover({ anchor: { x: 0, y: 0, width: 5, height: 5 }, size: { width: 100, height: 100 }, area: work, scale });
    const { x, y, width, height } = placed.rect;
    assert.equal(width, 0);
    assert.equal(height, 0);
    assert.ok(x >= work.x && x <= work.x + work.width, `x ${x} at ${scale}`);
    assert.ok(y >= work.y && y <= work.y + work.height, `y ${y} at ${scale}`);
  }
});

test("snap tolerance never lets an edge escape a tiny work area", () => {
  const work = { x: 10.0000000001, y: 20.0000000001, width: 0.3, height: 0.3 };
  for (const scale of [1, 2, 3]) {
    const placed = placePopover({ anchor: { x: 0, y: 0, width: 1, height: 1 }, size: { width: 50, height: 50 }, area: work, scale });
    const { x, y, width, height } = placed.rect;
    assert.ok(x >= work.x && x + width <= work.x + work.width, `x ${x} at ${scale}`);
    assert.ok(y >= work.y && y + height <= work.y + work.height, `y ${y} at ${scale}`);
    assert.ok(width >= 0 && height >= 0);
  }
  const edge = placePopover({ anchor: { x: 0, y: 0, width: 1, height: 1 }, size: { width: 50, height: 50 }, area: { x: 10.0000000001, y: 0, width: 100.0000000001, height: 100 }, scale: 1 });
  assert.ok(edge.rect.x >= 10.0000000001 + 8 - 1e-12);
});
