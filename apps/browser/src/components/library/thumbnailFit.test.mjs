import assert from "node:assert/strict";
import { test } from "node:test";

const { cropsToShow, dimensionsLabel, fitInBox, MAX_THUMBNAIL_POINTS, sharperPoints, validSize } = await import("./thumbnailFit.ts");

test("an ordinary picture fits its box whole", () => {
  assert.deepEqual(fitInBox(120, 3 / 2), { width: 120, height: 80 });
  assert.deepEqual(fitInBox(120, 2 / 3), { width: 80, height: 120 });
  assert.equal(cropsToShow(3 / 2), false);
});

test("a panorama shows as a 3:1 strip, never a hairline", () => {
  assert.deepEqual(fitInBox(120, 30_000 / 1_000), { width: 120, height: 40 });
  assert.deepEqual(fitInBox(120, 1_000 / 30_000), { width: 40, height: 120 });
  assert.equal(cropsToShow(30), true);
  assert.equal(cropsToShow(1 / 30), true);
});

test("a panorama's thumbnail is asked for again large enough to crop sharply, within the native limit", () => {
  assert.equal(sharperPoints(116, { width: 232, height: 8 }), MAX_THUMBNAIL_POINTS);
  assert.equal(sharperPoints(116, { width: 58, height: 232 }), 464);
  assert.equal(sharperPoints(116, { width: 232, height: 155 }), null);
  assert.equal(sharperPoints(MAX_THUMBNAIL_POINTS, { width: 2048, height: 68 }), null);
});

test("dimensions read as the image's own pixels, and nonsense sizes are refused", () => {
  assert.equal(dimensionsLabel({ width: 12000, height: 12000 }), "12000 × 12000");
  assert.equal(validSize({ width: 8192, height: 8192 }), true);
  for (const bad of [null, {}, { width: 0, height: 5 }, { width: Number.NaN, height: 5 }, { width: 5, height: -1 }]) assert.equal(validSize(bad), false);
});
