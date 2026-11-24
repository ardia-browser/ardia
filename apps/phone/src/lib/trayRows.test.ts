import assert from "node:assert/strict";
import { test } from "node:test";
import { rowFade, rowsOverflow, wholeRowsHeight } from "./trayRows.ts";

test("the list ends after the last row that fits whole, so no row is cut by the keyboard or the tray's edge", () => {
  assert.equal(wholeRowsHeight([66, 132, 198, 264], 230), 198);
  assert.equal(wholeRowsHeight([66, 132, 198, 264], 264), null);
  assert.equal(wholeRowsHeight([66, 132], 230), null);
});

test("a row measured past the room is enough to trim, even before the rows after it are measured", () => {
  assert.equal(wholeRowsHeight([66, 132, 198, 264, 0], 230), 198);
  assert.equal(wholeRowsHeight([66, 132, 0, 264], 230), null);
});

test("with no room measured, or not even one whole row, the list keeps its full height", () => {
  assert.equal(wholeRowsHeight([66, 132], 0), null);
  assert.equal(wholeRowsHeight([90, 180], 60), null);
});

test("rows that overflow fade over the bottom 30% of the room to 15%, each by the middle of its visible part, as SwiftUI's mask", () => {
  assert.equal(rowsOverflow(224, 200), true);
  assert.equal(rowsOverflow(200.4, 200), false);
  assert.equal(rowsOverflow(120, 0), false);
  assert.equal(rowFade(0, 56, 200, true), 1);
  assert.equal(rowFade(112, 168, 200, true), 1);
  assert.ok(Math.abs(rowFade(168, 224, 200, true) - (1 - 0.85 * (44 / 60))) < 1e-9);
  assert.equal(rowFade(224, 280, 200, true), 0.15);
  assert.equal(rowFade(168, 224, 200, false), 1);
});
