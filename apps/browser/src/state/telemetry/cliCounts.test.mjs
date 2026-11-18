import assert from "node:assert/strict";
import { test } from "node:test";

const { noteWindowlessPages, takeCliCounts } = await import("./cliCounts.ts");

const windowless = (counts) => [counts.windowless_pages_given_geometry, counts.windowless_pages_missing_geometry];

test("the engine's running totals of windowless pages turn into counts since the last take", () => {
  noteWindowlessPages(undefined);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 5, missed: 1 });
  assert.deepEqual(windowless(takeCliCounts()), [5, 1]);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
});

test("a status that arrives out of order never counts a page twice or takes one back", () => {
  noteWindowlessPages({ given: 8, missed: 1 });
  noteWindowlessPages({ given: 7, missed: 1 });
  noteWindowlessPages({ given: 8, missed: 2 });
  assert.deepEqual(windowless(takeCliCounts()), [3, 1]);
});
