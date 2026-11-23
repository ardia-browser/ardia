import assert from "node:assert/strict";
import { test } from "node:test";
const { AccessibilityInfo, Animated } = await import("react-native");
AccessibilityInfo.isReduceMotionEnabled = async () => true;
const { reduceMotion, reduceMotionKnown } = await import("./reduceMotion.ts");
const { popoverMotionStyle, popoverRise } = await import("./motion.ts");

await reduceMotionKnown;

test("a popover opening with Reduce Motion on only fades, with no scale or travel", () => {
  const appear = new Animated.Value(0);
  const style = popoverMotionStyle(appear, "top left", false, reduceMotion() !== false);
  assert.equal(style.opacity, appear);
  assert.deepEqual(style.transform, []);
});

test("a popover opening with Reduce Motion off grows from its anchor and travels toward it", () => {
  const appear = new Animated.Value(0);
  const below = popoverMotionStyle(appear, "top left", false, false);
  const above = popoverMotionStyle(appear, "bottom", true, false);
  assert.deepEqual(below.transform[0].scale.config.outputRange, [popoverRise.scale, 1]);
  assert.deepEqual(below.transform[1].translateY.config.outputRange, [-popoverRise.travel, 0]);
  assert.deepEqual(above.transform[1].translateY.config.outputRange, [popoverRise.travel, 0]);
});
