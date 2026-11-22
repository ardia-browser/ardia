import assert from "node:assert/strict";
import { test } from "node:test";
const { grainCellOf } = await import("../../../../packages/expo-windows/src/views/grainCell.ts");

test("the backdrop clamps the hash grain's cell to 0.25..4 px before the native view sees it, and a missing scale is 1", () => {
  assert.equal(grainCellOf(1), 1);
  assert.equal(grainCellOf(2.5), 2.5);
  assert.equal(grainCellOf(16), 4, "16 px cells would ask for a 4096 px tile");
  assert.equal(grainCellOf(0.1), 0.25);
  assert.equal(grainCellOf(undefined), 1);
  assert.equal(grainCellOf(Number.NaN), 1);
  assert.equal(grainCellOf(Number.POSITIVE_INFINITY), 1);
});
