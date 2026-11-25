import assert from "node:assert/strict";
import test from "node:test";
import { EAGER_SECTION_ROWS, FAR_OVERSCAN, LIST_PAGE_ROWS, NEAR_OVERSCAN, SLOW_SHEET_MS, eagerSections, sectionOverscan, sectionsWithin, sheetWasSlow } from "./sectionWindow.ts";

test("sections that start within the first screenful of rows render up front, the rest wait until they appear", () => {
  assert.deepEqual(eagerSections([10, 10, 10, 10], 24), [true, true, true, false]);
  assert.deepEqual(eagerSections([30, 1, 1], 24), [true, false, false]);
  assert.deepEqual(eagerSections([], 24), []);
});

test("thirty days of thirty-three archived tabs leave one day eager, so the sheet mounts a screenful instead of a window per day", () => {
  const days = Array.from({ length: 30 }, () => 33);
  const eager = eagerSections(days);
  assert.equal(eager.filter(Boolean).length, 1);
  const mounted = eager.reduce((rows, near) => rows + 1 + sectionOverscan(near), 0);
  assert.ok(mounted < 30 * (1 + NEAR_OVERSCAN) / 4, `${mounted} rows mount up front`);
  assert.equal(EAGER_SECTION_ROWS > 0, true);
});

test("a far section keeps a single row until it appears", () => {
  assert.equal(sectionOverscan(false), FAR_OVERSCAN);
  assert.equal(sectionOverscan(true), NEAR_OVERSCAN);
});

test("a sheet counts as slow only past the threshold and only when it was asked for", () => {
  assert.equal(sheetWasSlow(null, 5_000), false);
  assert.equal(sheetWasSlow(1_000, 1_000 + SLOW_SHEET_MS), false);
  assert.equal(sheetWasSlow(1_000, 1_001 + SLOW_SHEET_MS), true);
});

test("a list shows whole days until it reaches a page of rows, and always at least one day", () => {
  assert.equal(sectionsWithin([100, 100, 100], 200), 2);
  assert.equal(sectionsWithin([150, 100, 100], 200), 2);
  assert.equal(sectionsWithin([300, 10], 200), 1);
  assert.equal(sectionsWithin([10, 10], 200), 2);
  assert.equal(sectionsWithin([], 200), 0);
  assert.equal(LIST_PAGE_ROWS, 200);
});
