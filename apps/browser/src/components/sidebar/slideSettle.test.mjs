import assert from "node:assert/strict";
import { test } from "node:test";
const { settleSlides } = await import("./slideSettle.ts");

const slide = (over) => {
  const sets = [];
  return { value: { setValue: (v) => sets.push(v) }, sets, from: 37, at: 1000, until: 1180, run: null, landed: false, ...over };
};

test("a slide still running past its deadline is left to land by itself, and the overrun is reported", () => {
  const late = slide({ run: {} });
  assert.equal(settleSlides([late], 1500), true);
  assert.deepEqual(late.sets, []);
  assert.equal(late.until, 1180);
});

test("once the late slide has landed, the next pass retires it without touching its value", () => {
  const late = slide({ run: {} });
  settleSlides([late], 1500);
  late.run = null;
  late.landed = true;
  assert.equal(settleSlides([late], 1600), false);
  assert.deepEqual(late.sets, []);
  assert.equal(late.until, 0);
});

test("a slide that stopped short of its place is put there", () => {
  const stopped = slide();
  assert.equal(settleSlides([stopped], 1500), false);
  assert.deepEqual(stopped.sets, [0]);
  assert.equal(stopped.until, 0);
});

test("a slide inside its deadline is left alone, running or not", () => {
  const running = slide({ run: {} });
  const idle = slide();
  assert.equal(settleSlides([running, idle], 1100), false);
  assert.deepEqual([running.sets, idle.sets, running.until, idle.until], [[], [], 1180, 1180]);
});

test("one late slide does not hold back the others", () => {
  const late = slide({ run: {} });
  const stopped = slide();
  const landed = slide({ landed: true });
  assert.equal(settleSlides([late, stopped, landed], 1500), true);
  assert.deepEqual([late.sets, stopped.sets, landed.sets], [[], [0], []]);
  assert.deepEqual([late.until, stopped.until, landed.until], [1180, 0, 0]);
});
