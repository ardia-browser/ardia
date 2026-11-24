import assert from "node:assert/strict";
import { test } from "node:test";
const { seenSliding, shiftedBand, withOverscan } = await import("./listViewport.ts");

test("a slide is seen when any point of its path crosses the visible band", () => {
  const band = { top: 1000, bottom: 1800 };
  assert.equal(seenSliding(1200, 34, -37, band), true, "inside");
  assert.equal(seenSliding(2400, 34, -37, band), false, "below the band the whole way");
  assert.equal(seenSliding(300, 34, 37, band), false, "above the band the whole way");
  assert.equal(seenSliding(1790, 34, 37, band), true, "leaves the band through its bottom");
  assert.equal(seenSliding(1810, 34, -37, band), true, "comes up into the band");
  assert.equal(seenSliding(980, 34, -37, band), true, "its bottom edge is still in the band");
  assert.equal(seenSliding(5000, 34, -4000, band), true, "a long slide that passes through the band");
  assert.equal(seenSliding(5000, 34, 0, null), true, "with no band every slide is seen");
});

test("a band moves into a list's own coordinates and reaches one viewport past each edge", () => {
  assert.deepEqual(shiftedBand({ top: 100, bottom: 900 }, 37), { top: 63, bottom: 863 });
  assert.equal(shiftedBand(null, 37), null);
  assert.deepEqual(withOverscan(1000, 800), { top: 200, bottom: 2600 });
  assert.equal(seenSliding(2500, 34, -37, withOverscan(1000, 800)), true, "a row one viewport below is still animated");
  assert.equal(seenSliding(2700, 34, -37, withOverscan(1000, 800)), false);
});
