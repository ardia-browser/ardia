import assert from "node:assert/strict";
import { test } from "node:test";
import { isCardInViewport, previewSurface } from "./switcherPreview.ts";

const DARK_TOKENS = { blankFill: "#3A3A3C", onPage: "#000000A6", onDark: "#FFFFFFB3" };
const LIGHT_TOKENS = { blankFill: "#D1D1D6", onPage: "#000000A6", onDark: "#FFFFFFB3" };

test("a dark website uses its theme color and light icon, never flashing white", () => {
  assert.deepEqual(previewSurface("#0D1117", DARK_TOKENS), { fill: "#0D1117", icon: DARK_TOKENS.onDark });
  assert.deepEqual(previewSurface("#181818FF", LIGHT_TOKENS), { fill: "#181818", icon: LIGHT_TOKENS.onDark });
});

test("a light website uses its theme color and dark icon", () => {
  assert.deepEqual(previewSurface("#FFFFFF", DARK_TOKENS), { fill: "#FFFFFF", icon: DARK_TOKENS.onPage });
  assert.deepEqual(previewSurface("#F5F6F8", LIGHT_TOKENS), { fill: "#F5F6F8", icon: LIGHT_TOKENS.onPage });
});

test("missing or non-hex theme color falls back to the panel blank fill with matching icon contrast", () => {
  for (const color of [null, undefined, "", "rgb(0, 0, 0)", "not-a-color"]) {
    assert.deepEqual(previewSurface(color, DARK_TOKENS), { fill: DARK_TOKENS.blankFill, icon: DARK_TOKENS.onDark });
    assert.deepEqual(previewSurface(color, LIGHT_TOKENS), { fill: LIGHT_TOKENS.blankFill, icon: LIGHT_TOKENS.onPage });
  }
});

test("isCardInViewport selects only cards intersecting the current viewport", () => {
  const card = 160;
  const stride = 168;
  const viewport = 3 * card + 2 * 8;
  assert.equal(isCardInViewport(0, 0, viewport, card, stride), true);
  assert.equal(isCardInViewport(2, 0, viewport, card, stride), true);
  assert.equal(isCardInViewport(3, 0, viewport, card, stride), false);
  assert.equal(isCardInViewport(0, stride, viewport, card, stride), false);
  assert.equal(isCardInViewport(1, stride, viewport, card, stride), true);
  assert.equal(isCardInViewport(3, stride, viewport, card, stride), true);
  assert.equal(isCardInViewport(4, stride, viewport, card, stride), false);
});
