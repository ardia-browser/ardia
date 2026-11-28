import assert from "node:assert/strict";
import test from "node:test";
import { contrastBetween, legibleInk, luminance, readableInkOn } from "./color.ts";

test("a warning's orange is made legible on its surface as Compose's LegibleInk does: darkened in light until 4.5:1, left alone in dark where it already reads", () => {
  const light = legibleInk("#FF9500", false);
  assert.notEqual(light, "#FF9500");
  assert.ok(luminance(light) < luminance("#FF9500"));
  assert.equal(legibleInk("#FF9500", true), "#FF9500");
  assert.ok(luminance(legibleInk("#FF9500", false, true)) < luminance(light));
});

test("readable ink measures the color it returns, so rounding never leaves it under the target", () => {
  for (const [fill, ink] of [["#000000", "#070707"], ["#FFFFFF", "#F8F8F8"], ["#131318", "#25252F"], ["#F5F7FF", "#FFFFFF"], ["#7F7F7F", "#808080"]] as const) {
    assert.ok(contrastBetween(fill, readableInkOn(fill, ink)) >= 4.5, `${ink} on ${fill}`);
  }
  assert.equal(readableInkOn("#000000", "#FFFFFF"), "#FFFFFF");
});
