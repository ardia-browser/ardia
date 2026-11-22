import assert from "node:assert/strict";
import { test } from "node:test";
import { previewBackdrop } from "./switcherPreview.ts";

const DARK = { blankFill: "#3A3A3C", onPage: "#000000A6", onDark: "#FFFFFFB3" };
const LIGHT = { blankFill: "#D1D1D6", onPage: "#000000A6", onDark: "#FFFFFFB3" };

test("a card waits on its page's theme colour, with an icon that reads on it", () => {
  assert.deepEqual(previewBackdrop("#0D1117", DARK), { fill: "#0D1117", icon: DARK.onDark });
  assert.deepEqual(previewBackdrop("#F5F6F8", DARK), { fill: "#F5F6F8", icon: DARK.onPage });
  assert.deepEqual(previewBackdrop(" #181818FF", LIGHT), { fill: "#181818", icon: LIGHT.onDark });
});

test("with no usable theme colour a card waits on the panel's blank fill, never white", () => {
  for (const colour of [null, undefined, "", "rgb(0, 0, 0)", "red"]) {
    assert.deepEqual(previewBackdrop(colour, DARK), { fill: DARK.blankFill, icon: DARK.onDark });
    assert.deepEqual(previewBackdrop(colour, LIGHT), { fill: LIGHT.blankFill, icon: LIGHT.onPage });
  }
});
