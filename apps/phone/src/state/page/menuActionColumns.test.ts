import { test } from "node:test";
import assert from "node:assert/strict";
import { actionColumns, captionLines, evenColumnCounts } from "./menuActionColumns.ts";

const LABELS = ["Reader", "Find on Page", "Copy Link", "Share"];
const caption = (fontScale: number) => ({ fontSize: 12, fontScale, advance: 0.55, maxLines: 2 });
const GAP = 10;

test("four actions only ever split evenly: four, two or one to a row", () => {
  assert.deepEqual(evenColumnCounts(4), [4, 2, 1]);
});

test("at the default text size a phone-wide menu keeps all four actions in one row", () => {
  assert.equal(actionColumns(LABELS, 351, GAP, caption(1)), 4);
});

test("below the accessibility threshold a narrow menu drops to two columns when Find on Page cannot fit in two lines", () => {
  assert.equal(actionColumns(LABELS, 240, GAP, caption(1.235)), 2);
});

test("a larger text size on a wide menu keeps four columns and wraps Find on Page instead of truncating it", () => {
  assert.equal(actionColumns(LABELS, 351, GAP, caption(1.3)), 4);
  assert.equal(captionLines("Find on Page", (351 - GAP * 3) / 4, caption(1.3)), 2);
});

test("the column count follows the width, not the text-size threshold alone", () => {
  assert.equal(actionColumns(LABELS, 600, GAP, caption(1.7)), 4);
  assert.equal(actionColumns(LABELS, 351, GAP, caption(2.4)), 2);
  assert.equal(actionColumns(LABELS, 200, GAP, caption(3.1)), 1);
});

test("a word wider than the tile never fits, however many lines are allowed", () => {
  assert.equal(captionLines("Find on Page", 10, { ...caption(1), maxLines: 9 }), Number.POSITIVE_INFINITY);
});
