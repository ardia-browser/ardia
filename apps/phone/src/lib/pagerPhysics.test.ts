import assert from "node:assert/strict";
import test from "node:test";
import { incomingPose, neighbourAt, neighbours, outgoingPose } from "./pagerPhysics.ts";

test("a step goes delta places along the swipe order, as Compose's SwipeOrder.neighbor does, and off either end it goes nowhere", () => {
  const order = ["a", "b", "c", "d"];
  assert.equal(neighbourAt(order, "b", 1), "c");
  assert.equal(neighbourAt(order, "b", -1), "a");
  assert.equal(neighbourAt(order, "b", 2), "d");
  assert.equal(neighbourAt(order, "d", 1), null);
  assert.equal(neighbourAt(order, "x", 1), null);
  assert.deepEqual(neighbours(order, "a"), { left: null, right: "b" });
});

test("with Reduce Motion the outgoing page stays still and the incoming one fades in place, with no edge shadow, as Compose's PagerPoses", () => {
  assert.deepEqual(outgoingPose(-120, 400, true, true, true), { x: 0, scale: 1, dim: 0 });
  assert.deepEqual(incomingPose(1, -100, 400, true, true, true), { x: 0, opacity: 0.25, shadow: 0 });
  const moving = incomingPose(1, -100, 400, true, true);
  assert.equal(moving.x, 300);
  assert.equal(moving.shadow, 0.75);
});
