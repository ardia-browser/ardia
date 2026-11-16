import assert from "node:assert/strict";
import { test } from "node:test";
const { edgeOpacityAt } = await import("./edgeFade.ts");
const { autoScrollSpeed } = await import("./stripScroll.ts");
const { EDGE_FADE, EDGE_FADE_FLOOR } = await import("./tokens.ts");

const VIEWPORT = 1000;
const CONTENT = 3000;

const chip = (scroll, start, width = 32) => edgeOpacityAt(scroll, start, start + width, VIEWPORT, CONTENT);

test("nothing fades at the strip's start or end, where no tab is hidden", () => {
  assert.equal(chip(0, 4), 1);
  assert.equal(edgeOpacityAt(CONTENT - VIEWPORT, CONTENT - 40, CONTENT - 8, VIEWPORT, CONTENT), 1);
  assert.equal(edgeOpacityAt(0, 500, 532, VIEWPORT, 900), 1);
});

test("a scrolled strip fades the tabs within the fade width of an edge that hides tabs, by the side nearest that edge", () => {
  const scroll = 1000;
  assert.equal(chip(scroll, scroll - 10), EDGE_FADE_FLOOR);
  assert.equal(chip(scroll, scroll), EDGE_FADE_FLOOR);
  const halfway = chip(scroll, scroll + EDGE_FADE / 2);
  assert.ok(halfway > EDGE_FADE_FLOOR && halfway < 1);
  assert.equal(chip(scroll, scroll + EDGE_FADE + 1), 1);
  assert.equal(chip(scroll, scroll + VIEWPORT - 32), EDGE_FADE_FLOOR);
  assert.equal(chip(scroll, scroll + VIEWPORT / 2), 1);
});

test("a wide tab touching an edge fades as deeply as a narrow one: the fade follows its near side, not its centre", () => {
  const scroll = 1000;
  assert.equal(chip(scroll, scroll + 2, 128), chip(scroll, scroll + 2, 32));
  assert.ok(chip(scroll, scroll + 2, 128) < 0.3);
});

test("the left fade eases in over the first points of a scroll instead of popping", () => {
  const a = chip(2, 2);
  const b = chip(12, 12);
  assert.ok(a > b && b > EDGE_FADE_FLOOR);
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
