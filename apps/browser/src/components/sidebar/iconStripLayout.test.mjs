import assert from "node:assert/strict";
import { test } from "node:test";
const { ICON_STRIP, STRIP_DIVIDER_HEIGHT, stripLayout } = await import("./iconStripGeometry.ts");

const pitch = ICON_STRIP.square + ICON_STRIP.gap;
const plain = { divider: false, bars: [] };
const divider = { divider: true, bars: [] };
const inFolder = (group) => ({ divider: false, bars: [{ group }] });

test("the strip packs at one pitch from below the window buttons: tiles, a divider right under them, rows, then +", () => {
  const { tops, end } = stripLayout([plain, plain, divider, plain, plain], 100);
  assert.deepEqual(tops, [100, 100 + pitch, 100 + 2 * pitch, 100 + 2 * pitch + STRIP_DIVIDER_HEIGHT, 100 + 3 * pitch + STRIP_DIVIDER_HEIGHT]);
  assert.equal(end, 100 + 4 * pitch + STRIP_DIVIDER_HEIGHT, "+ follows the last row at the same pitch");
  assert.equal(tops[2] - (tops[1] + ICON_STRIP.square), ICON_STRIP.gap, "no gap under the divider beyond the pitch");
});

test("an open folder's tabs follow straight after the row above, and two folders in a row are kept apart by one gap", () => {
  const { tops } = stripLayout([plain, inFolder("a"), inFolder("a"), inFolder("b"), plain, inFolder("c")], 0);
  assert.deepEqual(tops, [0, pitch, 2 * pitch, 3 * pitch + ICON_STRIP.gap, 4 * pitch + ICON_STRIP.gap, 5 * pitch + ICON_STRIP.gap]);
});

test("a folder nested in another stays one run with its parent, not two folders", () => {
  const nested = { divider: false, bars: [{ group: "a" }, { group: "n" }] };
  const { tops } = stripLayout([inFolder("a"), nested, nested, inFolder("a")], 0);
  assert.deepEqual(tops, [0, pitch, 2 * pitch, 3 * pitch]);
});
