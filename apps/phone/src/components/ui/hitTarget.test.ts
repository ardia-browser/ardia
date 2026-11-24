import assert from "node:assert/strict";
import test from "node:test";
import { reachesTarget, slopToReach, slotAround, slotSide } from "./hitTarget.ts";
import { targetMinimum } from "./targetTokens.ts";

test("a small glyph sits centred in a slot of the minimum target size", () => {
  assert.deepEqual(slotAround(22.8), { width: targetMinimum, height: targetMinimum, alignItems: "center", justifyContent: "center" });
  assert.equal(slotSide(48), 48);
});

test("the search field's 32 by 40 accessories reach the minimum target only with the slop they are given", () => {
  assert.equal(reachesTarget(32, 40), false);
  const slop = slopToReach(32, 40);
  assert.deepEqual(slop, { top: 2, bottom: 2, left: 6, right: 6 });
  assert.equal(reachesTarget(32, 40, slop), true);
});

test("a control already at or over the minimum gets no slop", () => {
  assert.deepEqual(slopToReach(48, 50), { top: 0, bottom: 0, left: 0, right: 0 });
});
