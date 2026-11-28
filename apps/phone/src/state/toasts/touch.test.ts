import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_TOAST_TOUCH, TOAST_TAP_MAX_MS, TOAST_TOUCH_SLOP, toastTouchDown, toastTouchDrag, toastTouchMove, toastTouchUp } from "./touch.ts";

test("a still finger is a tap, judged in screen points, so a card that moves or updates under the finger never turns the tap into a drag", () => {
  const down = toastTouchDown(908, 2107, 0);
  assert.equal(toastTouchUp(down, 50), "tap");
  const held = toastTouchMove(down, 908, 2107, 30);
  assert.equal(held.phase, "pressed");
  assert.equal(toastTouchUp(held, 60), "tap");
});

test("a small wobble under the slop still taps, and a press held past the tap window does nothing", () => {
  const down = toastTouchDown(100, 100, 0);
  const wobble = toastTouchMove(down, 100 + TOAST_TOUCH_SLOP - 1, 100 + TOAST_TOUCH_SLOP, 20);
  assert.equal(toastTouchUp(wobble, 80), "tap");
  assert.equal(toastTouchUp(down, TOAST_TAP_MAX_MS + 1), "none");
});

test("a drag down past 24 points or a flick dismisses, a short drag settles back, and an upward drag never dismisses", () => {
  const down = toastTouchDown(100, 100, 0);
  const far = toastTouchMove(toastTouchMove(down, 100, 112, 100), 100, 130, 400);
  assert.equal(far.phase, "dragging");
  assert.equal(toastTouchDrag(far), 30);
  assert.equal(toastTouchUp(far, 420), "dismiss");
  const short = toastTouchMove(toastTouchMove(down, 100, 110, 200), 100, 112, 400);
  assert.equal(toastTouchUp(short, 420), "settle");
  const flick = toastTouchMove(toastTouchMove(down, 100, 110, 10), 100, 118, 20);
  assert.equal(toastTouchUp(flick, 25), "dismiss");
  const up = toastTouchMove(down, 100, 60, 200);
  assert.equal(toastTouchUp(up, 220), "settle");
});

test("a sideways swipe is neither a tap nor a drag, and an idle touch ends in nothing", () => {
  const down = toastTouchDown(100, 100, 0);
  const side = toastTouchMove(down, 140, 102, 50);
  assert.equal(side.phase, "gone");
  assert.equal(toastTouchUp(side, 60), "none");
  assert.equal(toastTouchUp(IDLE_TOAST_TOUCH, 10), "none");
});
