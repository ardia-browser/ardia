import assert from "node:assert/strict";
import test from "node:test";
import {
  clampedProgress,
  keyboardIsUp,
  keyboardProgress,
  liveLift,
  TRAY_DRAG,
  trayDismissDistance,
  trayDragDismisses,
  trayDragOffset,
  trayDragReleasesKeyboard,
  trayDragTranslation,
  trayMaxHeight,
  trayOffset,
  trayVelocity,
} from "./trayMotion.ts";

const close = (actual: number, expected: number, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

test("a downward drag follows the finger, an upward one resists to the same numbers as Compose and SwiftUI", () => {
  assert.equal(trayDragOffset(0), 0);
  assert.equal(trayDragOffset(84), 84);
  close(trayDragOffset(-10), -7.826086956521738);
  close(trayDragOffset(-400), -33.02752293577982);
  assert.ok(trayDragOffset(-4000) > -TRAY_DRAG.upwardLimit);
});

test("a slow short drag springs back, a slow long one or a flick dismisses, and moving back up cancels", () => {
  assert.equal(trayDragDismisses(40, 60, 274), false);
  close(trayDismissDistance(274), 95.89999999999999);
  assert.equal(trayDragDismisses(trayDismissDistance(274) + 1, 0, 274), true);
  assert.equal(trayDragDismisses(14, 1200, 274), true);
  assert.equal(trayDragDismisses(200, -600, 274), false);
  assert.equal(trayDragDismisses(-20, 1500, 274), false);
  assert.ok(trayDismissDistance(78) < trayDismissDistance(274));
  assert.equal(trayDismissDistance(2000), TRAY_DRAG.distanceCap);
});

test("the keyboard waits for a deliberate pull of more than 8 points", () => {
  assert.equal(trayDragReleasesKeyboard(3), false);
  assert.equal(trayDragReleasesKeyboard(-30), false);
  assert.equal(trayDragReleasesKeyboard(20), true);
});

test("progress is clamped to the travel", () => {
  assert.equal(clampedProgress(-10, 300), 0);
  assert.equal(clampedProgress(150, 300), 0.5);
  assert.equal(clampedProgress(900, 300), 1);
  assert.equal(clampedProgress(50, 0), 0);
});

test("the keyboard counts as up only above 120 points, and its progress follows it both ways", () => {
  assert.equal(keyboardIsUp(120), false);
  assert.equal(keyboardIsUp(121), true);
  close(keyboardProgress(150, 0, 300), 0.5);
  close(keyboardProgress(75, 300, 0), 0.25);
  assert.equal(keyboardProgress(300, 300, 300), 1);
  assert.equal(keyboardProgress(40, 40, 40), 0);
});

test("a landed tray rests above the gesture bar when the keyboard is down", () => {
  assert.equal(liveLift(0, 24, true, false), 24);
  assert.equal(liveLift(0, 24, false, false), 0);
  assert.equal(liveLift(0, 24, true, true), 0);
  assert.equal(liveLift(300, 24, true, false), 300);
});

test("a risen tray sits on the keyboard, a fallen one is wholly below the screen, and following the keyboard never moves back", () => {
  assert.equal(trayOffset(300, 0, 1, 274, 40), -300);
  assert.equal(trayOffset(0, 0, 0, 274, 40), 314);
  assert.equal(trayOffset(300, 0, 0, 274, 40), 314);
  let previous = Infinity;
  for (let step = 0; step <= 60; step++) {
    const progress = step / 60;
    const y = trayOffset(300 * progress, 0, progress, 274, 40);
    assert.ok(y <= previous);
    previous = y;
  }
});

test("the tray is shorter when the screen leaves less room", () => {
  assert.equal(trayMaxHeight(274, 800, 300, 8), 274);
  assert.equal(trayMaxHeight(274, 500, 300, 8), 192);
  assert.equal(trayMaxHeight(274, 200, 300, 8), 0);
});

test("a grab mid-spring turns the shown offset back into the finger's travel, as SwiftUI's TrayDrag.translation(for:)", () => {
  assert.equal(trayDragTranslation(40), 40);
  assert.equal(trayDragTranslation(0), 0);
  for (const travel of [-5, -30, -120]) close(trayDragTranslation(trayDragOffset(travel)), travel, 1e-6);
  assert.ok(Number.isFinite(trayDragTranslation(-TRAY_DRAG.upwardLimit * 2)));
});

test("the tray's release speed follows the finger downward and slows with the rubber band upward, as SwiftUI's TrayDrag.trayVelocity", () => {
  assert.equal(trayVelocity(50, 900), 900);
  assert.equal(trayVelocity(0, -300), -300);
  close(trayVelocity(-TRAY_DRAG.upwardLimit, -400), -100);
});
