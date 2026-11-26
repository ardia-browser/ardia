import assert from "node:assert/strict";
import { test } from "node:test";
import { clampTo, rangeOf, sectionFrames } from "./sectionRange.ts";

test("a question that fits is centred and has no room to scroll", () => {
  assert.deepEqual(rangeOf({ y: 1000, h: 200 }, 600, 32), { lo: 800, hi: 800 });
});

test("a taller question scrolls from its top edge to its bottom edge", () => {
  assert.deepEqual(rangeOf({ y: 1000, h: 700 }, 600, 32), { lo: 968, hi: 1132 });
});

test("nothing is measured yet, so there is no range", () => {
  assert.equal(rangeOf(undefined, 600, 32), null);
  assert.equal(rangeOf({ y: 0, h: 10 }, 0, 32), null);
});

test("positions clamp into the range", () => {
  assert.equal(clampTo(10, { lo: 20, hi: 30 }), 20);
  assert.equal(clampTo(40, { lo: 20, hi: 30 }), 30);
});

test("section frames recompute y offsets from viewport padding and measured heights", () => {
  const heights = { a: 500, b: 220 };
  const initial = sectionFrames(["a", "b"], heights, 460, 64);
  assert.deepEqual(initial, { a: { y: 230, h: 500 }, b: { y: 794, h: 220 } });
  const resized = sectionFrames(["a", "b"], heights, 930, 64);
  assert.deepEqual(resized, { a: { y: 465, h: 500 }, b: { y: 1029, h: 220 } });
  assert.deepEqual(rangeOf(resized.b, 930, 32), { lo: 674, hi: 674 });
  assert.deepEqual(sectionFrames(["a", "b"], { a: 500 }, 0, 64), {});
});
