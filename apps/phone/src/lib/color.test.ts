import assert from "node:assert/strict";
import test from "node:test";
import { legibleInk, luminance } from "./color.ts";

test("a warning's orange is made legible on its surface as Compose's LegibleInk does: darkened in light until 4.5:1, left alone in dark where it already reads", () => {
  const light = legibleInk("#FF9500", false);
  assert.notEqual(light, "#FF9500");
  assert.ok(luminance(light) < luminance("#FF9500"));
  assert.equal(legibleInk("#FF9500", true), "#FF9500");
  assert.ok(luminance(legibleInk("#FF9500", false, true)) < luminance(light));
});
