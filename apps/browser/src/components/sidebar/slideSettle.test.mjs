import assert from "node:assert/strict";
import { test } from "node:test";
const { settleSlides } = await import("./slideSettle.ts");

const slide = (over) => {
  const sets = [];
  return { value: { setValue: (v) => sets.push(v) }, sets, from: 37, at: 1000, until: 1180, run: null, landed: false, ...over };
};

test("a slide still running past its deadline is left to land by itself, and the overrun is reported", () => {
  const late = slide({ run: {} });
  assert.deepEqual(settleSlides([late], 1500), { overrun: true, stopped: 0 });
  assert.deepEqual(late.sets, []);
  assert.equal(late.until, 1180);
});

test("once the late slide has landed, the next pass retires it without touching its value", () => {
  const late = slide({ run: {} });
  settleSlides([late], 1500);
  late.run = null;
  late.landed = true;
  assert.deepEqual(settleSlides([late], 1600), { overrun: false, stopped: 0 });
  assert.deepEqual(late.sets, []);
  assert.equal(late.until, 0);
});

test("a slide that stopped short of its place is put there and counted as stopped", () => {
  const stopped = slide();
  assert.deepEqual(settleSlides([stopped], 1500), { overrun: false, stopped: 1 });
  assert.deepEqual(stopped.sets, [0]);
  assert.equal(stopped.until, 0);
  assert.deepEqual(settleSlides([stopped], 1600), { overrun: false, stopped: 0 });
  assert.deepEqual(stopped.sets, [0]);
});

test("a slide inside its deadline is left alone, running or not", () => {
  const running = slide({ run: {} });
  const idle = slide();
  assert.deepEqual(settleSlides([running, idle], 1100), { overrun: false, stopped: 0 });
  assert.deepEqual([running.sets, idle.sets, running.until, idle.until], [[], [], 1180, 1180]);
});

test("one late slide does not hold back the others, and only the stopped one is counted", () => {
  const late = slide({ run: {} });
  const stopped = slide();
  const landed = slide({ landed: true });
  assert.deepEqual(settleSlides([late, stopped, landed], 1500), { overrun: true, stopped: 1 });
  assert.deepEqual([late.sets, stopped.sets, landed.sets], [[], [0], []]);
  assert.deepEqual([late.until, stopped.until, landed.until], [1180, 0, 0]);
});

test("every slide that stopped short in one pass is counted", () => {
  const a = slide();
  const b = slide();
  const landed = slide({ landed: true });
  assert.deepEqual(settleSlides([a, b, landed], 1500), { overrun: false, stopped: 2 });
  assert.deepEqual([a.sets, b.sets, landed.sets], [[0], [0], []]);
});

test("a slide with no deadline set, or one that landed, is never counted as stopped", () => {
  const idle = slide({ until: 0 });
  const landed = slide({ landed: true });
  assert.deepEqual(settleSlides([idle, landed], 1500), { overrun: false, stopped: 0 });
  assert.deepEqual([idle.sets, landed.sets], [[], []]);
});
