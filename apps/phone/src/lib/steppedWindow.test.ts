import assert from "node:assert/strict";
import test from "node:test";
import { getSlotIndices, getWindow } from "./steppedWindow.ts";

test("the row window moves in steps of the overscan, so scrolling one row at a time changes it once every ten rows", () => {
  const starts = new Set<number>();
  let capacity = 0;
  for (let first = 0; first < 100; first++) {
    const window = getWindow(3_000, first, first + 12, 10, capacity);
    capacity = window.capacity;
    starts.add(window.start);
    assert.ok(window.start <= Math.max(0, first - 10), `row ${first} keeps ten rows above`);
    assert.ok(window.start + window.capacity >= Math.min(3_000, first + 12 + 1 + 10), `row ${first} keeps ten rows below`);
  }
  assert.ok(starts.size <= 11, `${starts.size} different windows over 100 rows`);
});

test("the window stays inside the data and an empty list has none", () => {
  assert.deepEqual(getWindow(0, 0, 0, 10), { start: 0, capacity: 0 });
  const end = getWindow(25, 20, 24, 10);
  assert.ok(end.start + end.capacity <= 25);
  assert.deepEqual(getSlotIndices(0, 0), []);
  assert.deepEqual(getSlotIndices(10, 5).sort((a, b) => a - b), [10, 11, 12, 13, 14]);
});
