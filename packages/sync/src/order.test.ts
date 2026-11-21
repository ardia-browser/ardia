import assert from "node:assert/strict";
import { test } from "node:test";
import { assignPositions } from "./order.ts";

test("new siblings find the next kept position once, not once per sibling", () => {
  const has = Set.prototype.has;
  let lookups = 0;
  Set.prototype.has = function (key) {
    lookups++;
    return has.call(this, key);
  };
  let positions: string[];
  try {
    positions = assignPositions([...Array(2000).fill(undefined), "V", ...Array(2000).fill(undefined)]);
  } finally {
    Set.prototype.has = has;
  }
  assert.ok(lookups <= 3 * positions.length, `${lookups} lookups for ${positions.length} positions`);
  assert.equal(positions[2000], "V");
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i - 1]! < positions[i]!, `${positions[i - 1]} < ${positions[i]}`);
});
