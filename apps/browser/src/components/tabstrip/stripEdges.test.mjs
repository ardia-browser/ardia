import assert from "node:assert/strict";
import { test } from "node:test";
const { edgeMaskAt, edgeMaskGradient, edgeStrength } = await import("./edgeFade.ts");
const { autoScrollSpeed } = await import("./stripScroll.ts");
const { EDGE_FADE, EDGE_FADE_FLOOR, EDGE_FADE_ONSET } = await import("./tokens.ts");

const VIEWPORT = 1000;
const CONTENT = 3000;

const at = (scroll, x, content = CONTENT) => edgeMaskAt(x, VIEWPORT, edgeStrength(scroll, VIEWPORT, content));

test("nothing fades at the strip's start or end, where no tab is hidden", () => {
  assert.equal(at(0, 0), 1);
  assert.equal(at(CONTENT - VIEWPORT, VIEWPORT), 1);
  assert.equal(at(0, VIEWPORT, 900), 1);
  assert.deepEqual(edgeStrength(0, VIEWPORT, 900), { left: 0, right: 0 });
});

test("a scrolled strip fades its pixels within the fade width of an edge that hides tabs, deepest at the edge", () => {
  const scroll = 1000;
  assert.equal(at(scroll, 0), EDGE_FADE_FLOOR);
  assert.equal(at(scroll, VIEWPORT), EDGE_FADE_FLOOR);
  const halfway = at(scroll, EDGE_FADE / 2);
  assert.ok(halfway > EDGE_FADE_FLOOR && halfway < 1);
  assert.equal(at(scroll, EDGE_FADE + 1), 1);
  assert.equal(at(scroll, VIEWPORT / 2), 1);
});

test("a tab across the edge fades along its width: its near side is dimmer than its far side", () => {
  const scroll = 1000;
  assert.ok(at(scroll, 4) < at(scroll, 60));
  assert.ok(at(scroll, VIEWPORT - 4) < at(scroll, VIEWPORT - 60));
});

test("the left fade eases in over the first points of a scroll instead of popping", () => {
  const a = at(2, 0);
  const b = at(12, 0);
  assert.ok(a > b && b > EDGE_FADE_FLOOR);
  assert.equal(at(EDGE_FADE_ONSET, 0), EDGE_FADE_FLOOR);
});

test("the native gradient's stops draw the same mask as the formula", () => {
  const strength = edgeStrength(12, VIEWPORT, CONTENT);
  const { alphas, stops } = edgeMaskGradient(VIEWPORT, strength);
  const lerp = (x) => {
    const p = x / VIEWPORT;
    const i = stops.findIndex((s, k) => k > 0 && p <= s);
    const t = (p - stops[i - 1]) / (stops[i] - stops[i - 1] || 1);
    return alphas[i - 1] + t * (alphas[i] - alphas[i - 1]);
  };
  for (const x of [0, 20, EDGE_FADE / 2, EDGE_FADE, 500, VIEWPORT - 30, VIEWPORT]) assert.ok(Math.abs(lerp(x) - edgeMaskAt(x, VIEWPORT, strength)) < 1e-9, String(x));
});

test("a drag scrolls the strip only near an edge it can scroll toward, faster the deeper the pointer, capped", () => {
  const view = [100, 1100];
  assert.equal(autoScrollSpeed(600, view, 500, 2000, 48, 14), 0);
  assert.ok(autoScrollSpeed(1090, view, 500, 2000, 48, 14) > autoScrollSpeed(1060, view, 500, 2000, 48, 14));
  assert.equal(autoScrollSpeed(1200, view, 500, 2000, 48, 14), 14);
  assert.equal(autoScrollSpeed(90, view, 500, 2000, 48, 14), -14);
  assert.equal(autoScrollSpeed(110, view, 0, 2000, 48, 14), 0);
  assert.equal(autoScrollSpeed(1090, view, 2000, 2000, 48, 14), 0);
  assert.equal(autoScrollSpeed(1053, view, 500, 2000, 48, 14), 1);
});

test("two overlapping drags keep chips shown until both have settled, whatever order they end in", async () => {
  const { shownHolds } = await import("./stripScroll.ts");
  const seen = [];
  const hold = shownHolds((held) => seen.push(held));
  const first = hold();
  const second = hold();
  first();
  assert.deepEqual(seen, [true], "the first drag settling leaves the second's hold in place");
  first();
  assert.deepEqual(seen, [true], "a release given twice counts once");
  second();
  assert.deepEqual(seen, [true, false]);
});
