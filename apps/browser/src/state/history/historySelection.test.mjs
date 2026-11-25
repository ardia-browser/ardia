import assert from "node:assert/strict";
import { test } from "node:test";
import { allRows, movedCursor, NO_ROWS_SELECTED, shownRows, toggledCursor, toggledRow, withoutRows } from "./historySelection.ts";

const urls = ["a", "b", "c", "d", "e", "f"];
const picked = (s) => [...s.selected].sort();

test("arrows move the highlighted row, and Shift-arrows select from where they started", () => {
  let s = movedCursor(urls, NO_ROWS_SELECTED, 1, false);
  assert.equal(s.cursor, "a");
  s = movedCursor(urls, s, 1, false);
  assert.equal(s.cursor, "b");
  assert.deepEqual(picked(s), []);
  s = movedCursor(urls, s, 1, true);
  s = movedCursor(urls, s, 1, true);
  assert.equal(s.cursor, "d");
  assert.deepEqual(picked(s), ["b", "c", "d"]);
  assert.equal(movedCursor(urls, { ...s, cursor: "f" }, 1, false).cursor, "f");
  assert.equal(movedCursor(urls, NO_ROWS_SELECTED, -1, false).cursor, "f");
});

test("Space toggles the highlighted row, ⌘A selects every shown row", () => {
  let s = movedCursor(urls, NO_ROWS_SELECTED, 1, false);
  s = toggledCursor(urls, s);
  assert.deepEqual(picked(s), ["a"]);
  s = toggledCursor(urls, s);
  assert.deepEqual(picked(s), []);
  assert.equal(toggledCursor(urls, NO_ROWS_SELECTED), NO_ROWS_SELECTED);
  assert.deepEqual(picked(allRows(urls, s)), urls);
});

test("a Shift-click on a checkbox or row selects the range from the last one clicked", () => {
  let s = toggledRow(urls, NO_ROWS_SELECTED, "b", false);
  s = toggledRow(urls, s, "e", true);
  assert.deepEqual(picked(s), ["b", "c", "d", "e"]);
  s = toggledRow(urls, s, "c", false);
  assert.deepEqual(picked(s), ["b", "d", "e"]);
});

test("rows a search hides or a delete removes leave the selection and the highlight", () => {
  const s = { selected: new Set(["a", "c"]), anchor: "c", cursor: "c" };
  const shown = shownRows(["a", "b"], s);
  assert.deepEqual(picked(shown), ["a"]);
  assert.equal(shown.cursor, null);
  assert.equal(shownRows(urls, s), s);
  assert.deepEqual(picked(withoutRows(s, ["c"])), ["a"]);
});

test("Shift-arrows back over a range drop the rows they leave, and the range turns past where it started", () => {
  let s = movedCursor(urls, NO_ROWS_SELECTED, 1, false);
  s = movedCursor(urls, s, 1, true);
  s = movedCursor(urls, s, 1, true);
  assert.deepEqual(picked(s), ["a", "b", "c"]);
  s = movedCursor(urls, s, -1, true);
  assert.equal(s.cursor, "b");
  assert.deepEqual(picked(s), ["a", "b"]);
  s = movedCursor(urls, { ...s, anchor: "c", cursor: "c", selected: new Set(["c"]) }, -1, true);
  s = movedCursor(urls, s, -1, true);
  assert.deepEqual(picked(s), ["a", "b", "c"]);
  s = movedCursor(urls, s, 1, true);
  s = movedCursor(urls, s, 1, true);
  s = movedCursor(urls, s, 1, true);
  assert.deepEqual(picked(s), ["c", "d"]);
});

test("Shift-clicks keep the row first clicked as the range's start, and rows checked outside the range stay", () => {
  let s = toggledRow(urls, NO_ROWS_SELECTED, "f", false);
  s = toggledRow(urls, s, "b", false);
  s = toggledRow(urls, s, "e", true);
  assert.deepEqual(picked(s), ["b", "c", "d", "e", "f"]);
  s = toggledRow(urls, s, "c", true);
  assert.deepEqual(picked(s), ["b", "c", "f"]);
  assert.equal(s.anchor, "b");
});
