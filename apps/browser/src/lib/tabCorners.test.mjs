import { test } from "node:test";
import assert from "node:assert/strict";

const { tabCornersControl, TAB_CORNERS } = await import("./tabCorners.ts");

test("a theme's radius past the slider's range keeps the thumb on the track and the real radius in the label", () => {
  const control = tabCornersControl(24, null);
  assert.equal(control.position, 1);
  assert.equal(control.label, "24 pt");
  assert.equal(tabCornersControl(10, null).position, 10 / TAB_CORNERS.max);
  assert.equal(tabCornersControl(0, 0).label, "Square");
});

test("Tab corners offers to follow the theme again only once the slider has set a radius", () => {
  assert.equal(tabCornersControl(10, null).followsTheme, true);
  assert.equal(tabCornersControl(10, 10).followsTheme, false);
  assert.equal(tabCornersControl(0, 0).followsTheme, false);
});
