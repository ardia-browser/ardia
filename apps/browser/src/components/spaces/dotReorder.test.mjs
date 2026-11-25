import assert from "node:assert/strict";
import { test } from "node:test";
import { dotDrag, dotShifts, movedOrder } from "./dotReorder.ts";

const dots = [12, 12, 12, 12, 12];

test("a dot dragged over its neighbour's centre takes that neighbour's place", () => {
  assert.deepEqual(dotDrag(dots, 1, 7), { shift: 7, to: 1 });
  assert.deepEqual(dotDrag(dots, 1, 13), { shift: 13, to: 2 });
  assert.deepEqual(dotDrag(dots, 3, -11), { shift: -11, to: 3 });
  assert.deepEqual(dotDrag(dots, 3, -13), { shift: -13, to: 2 });
  assert.deepEqual(dotDrag(dots, 3, -25), { shift: -25, to: 1 });
});

test("a dragged dot stays within the row and can reach either end", () => {
  assert.deepEqual(dotDrag(dots, 1, -100), { shift: -12, to: 0 });
  assert.deepEqual(dotDrag(dots, 1, 100), { shift: 36, to: 4 });
});

test("icons and dots of different widths swap at the neighbour's centre", () => {
  const mixed = [26, 12, 26];
  assert.equal(dotDrag(mixed, 1, 18).to, 1);
  assert.equal(dotDrag(mixed, 1, 19).to, 2);
  assert.equal(dotDrag(mixed, 0, 18).to, 0);
  assert.equal(dotDrag(mixed, 0, 19).to, 1);
  assert.equal(dotDrag(mixed, 0, 100).to, 2);
});

test("the dots between the old and new place slide over by the dragged dot's width", () => {
  assert.deepEqual(dotShifts(dots, 1, 3), [0, 0, -12, -12, 0]);
  assert.deepEqual(dotShifts(dots, 3, 1), [0, 12, 12, 0, 0]);
  assert.deepEqual(dotShifts([26, 12, 26], 0, 2), [0, -26, -26]);
  assert.deepEqual(dotShifts(dots, 2, 2), [0, 0, 0, 0, 0]);
});

test("the new order moves only the dragged profile", () => {
  assert.deepEqual(movedOrder(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(movedOrder(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  const same = ["a", "b"];
  assert.equal(movedOrder(same, 1, 1), same);
});
