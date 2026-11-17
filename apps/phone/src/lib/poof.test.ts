import assert from "node:assert/strict";
import test from "node:test";
import { POOF, poofPuff, poofCentreY } from "./poof.ts";

test("the poof is Compose's PoofBurst: nine puffs flying out and growing, and a centre puff shrinking by half", () => {
  const start = poofPuff(0, 0, 100);
  const end = poofPuff(0, 1, 100);
  assert.ok(Math.abs(Math.hypot(start.dx, start.dy) - 46 * 0.35) < 1e-9);
  assert.ok(Math.abs(Math.hypot(end.dx, end.dy) - 46) < 1e-9);
  assert.ok(Math.abs(end.radius - 20 * 1.2) < 1e-9);
  assert.equal(poofPuff(1, 1, 100).radius, 15 * 1.2);
  assert.equal(poofPuff(POOF.count, 0, 100).radius, 21);
  assert.equal(poofPuff(POOF.count, 1, 100).radius, 10.5);
});

test("a poof keeps half its size of room below the status bar, so a card flicked from the top of the screen still bursts where it can be seen", () => {
  assert.equal(poofCentreY(400, 300, 40), 400);
  assert.equal(poofCentreY(60, 300, 40), 190);
  assert.equal(poofCentreY(-120, 300, 40), 190);
});
