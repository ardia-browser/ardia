import assert from "node:assert/strict";
import test from "node:test";
import { createFieldTiming } from "./fieldTiming.ts";

function harness() {
  const listeners = new Map();
  const target = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  let clock = 1_000;
  const painted = [];
  const timing = createFieldTiming(target, { now: () => clock, eventTime: (event) => event.at, afterPaint: (run) => painted.push(run) });
  return { timing, listeners, painted, tick: (to) => (clock = to) };
}

test("Linux field timing marks a frame after it paints and hands each mark over once", () => {
  const { timing, painted, tick } = harness();
  timing.setEnabled(true);
  timing.markFrame("tab-1", "frame");
  assert.deepEqual(timing.drain(), []);
  tick(1_016.44);
  painted.shift()();
  assert.deepEqual(timing.drain(), [["tab-1", "frame", 1_016.4]]);
  assert.deepEqual(timing.drain(), []);
});

test("Linux field timing keeps the last key press or pointer press while it is on, and nothing while it is off", () => {
  const { timing, listeners } = harness();
  assert.equal(listeners.size, 0);
  timing.setEnabled(true);
  listeners.get("keydown")({ type: "keydown", at: 500 });
  assert.deepEqual(timing.lastInput(), [500, 1]);
  listeners.get("pointerdown")({ type: "pointerdown", at: 700 });
  assert.deepEqual(timing.lastInput(), [700, 2]);
  timing.markFrame("tab-1", "frame");
  timing.setEnabled(false);
  assert.equal(listeners.size, 0);
  assert.deepEqual(timing.drain(), []);
  assert.deepEqual(timing.lastInput(), [0, 0]);
  assert.equal(timing.pageMarks, false);
});

test("a frame asked for before Linux field timing went off and on again is never marked", () => {
  const { timing, painted } = harness();
  timing.setEnabled(true);
  timing.markFrame("tab-1", "frame");
  timing.setEnabled(false);
  timing.setEnabled(true);
  painted.shift()();
  assert.deepEqual(timing.drain(), []);
});
