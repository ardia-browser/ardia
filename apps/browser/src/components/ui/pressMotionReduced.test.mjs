import assert from "node:assert/strict";
import { test } from "node:test";
const { AccessibilityInfo } = await import("react-native");
AccessibilityInfo.isReduceMotionEnabled = async () => true;
const { reduceMotionKnown } = await import("./reduceMotion.ts");
const { liftSpring, springs } = await import("./motion.ts");
const { setPressMotion } = await import("../../lib/pressMotion.ts");

await reduceMotionKnown;

test("with Reduce Motion on, pressMotion bounce lifts a New Tab card and a live item's check mark without the bounce", (t) => {
  setPressMotion("bounce");
  t.after(() => setPressMotion("still"));
  assert.equal(liftSpring(), springs.snappy);
});
