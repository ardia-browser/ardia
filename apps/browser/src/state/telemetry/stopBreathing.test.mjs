import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { noteStopBreathing, takeStopBreathing } from "./stopBreathing.ts";

test("stop_breathing_s counts the time any window's stop button breathed, once, and starts over after each sample", () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    noteStopBreathing(true);
    mock.timers.tick(2000);
    noteStopBreathing(true);
    mock.timers.tick(3000);
    noteStopBreathing(false);
    mock.timers.tick(1000);
    noteStopBreathing(false);
    mock.timers.tick(9000);
    assert.deepEqual(takeStopBreathing(), { stop_breathing_s: 6 });
    assert.deepEqual(takeStopBreathing(), { stop_breathing_s: 0 });
    noteStopBreathing(false);
    noteStopBreathing(true);
    mock.timers.tick(4000);
    assert.deepEqual(takeStopBreathing(), { stop_breathing_s: 4 });
    mock.timers.tick(2500);
    noteStopBreathing(false);
    assert.deepEqual(takeStopBreathing(), { stop_breathing_s: 3 });
  } finally {
    mock.timers.reset();
  }
});
