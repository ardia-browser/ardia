import assert from "node:assert/strict";
import { test } from "node:test";
import { windowGaps } from "./windowGaps.mjs";

const P = 1000 / 120;
const steady = (from, to) => Array.from({ length: Math.round((to - from) / P) + 1 }, (_, i) => from + i * P);

test("steady ticks have no late frames and the longest gap is one period", () => {
  const r = windowGaps(steady(0, 400), 100, 300, P);
  assert.equal(r.late, 0);
  assert.ok(Math.abs(r.maxGap - P) < 1e-9);
});

test("a gap that starts before the window counts only its part inside the window, and only the ticks due inside it", () => {
  const r = windowGaps([90, 98, 250, 258], 100, 300, P);
  assert.equal(r.maxGap, 150);
  assert.equal(r.late, 17);
});

test("a gap that runs past the end counts only up to the end", () => {
  const r = windowGaps([200, 208, 400], 100, 300, P);
  assert.equal(r.maxGap, 92);
  assert.equal(r.late, 11);
});

test("a gap that spans the whole window counts the whole window and every tick due in it", () => {
  const r = windowGaps([92, 400], 100, 300, P);
  assert.equal(r.maxGap, 200);
  assert.equal(r.late, 24);
});
