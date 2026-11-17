import assert from "node:assert/strict";
import { test } from "node:test";
import { followMotion, requestFrame } from "../../../../packages/expo-windows/src/animation/motion.ts";

class Value { __makeNative() {} }
class Color { __makeNative() {} }
class Animation {
  __active = true;
  native = false;
  start() {}
  __startAnimationIfNative() { return this.native; }
  __notifyAnimationEnd() { this.__active = false; }
}
class Timing extends Animation {
  start() { super.start(); this.__startAnimationIfNative(new Value()); }
}
const helper = { shouldUseNativeDriver: () => false };
globalThis.require = (name) => ({ default: name.endsWith("NativeAnimatedHelper") ? helper : name.endsWith("AnimatedValue") ? Value : name.endsWith("AnimatedColor") ? Color : name.endsWith("/Animation") ? Animation : { transform: { process: (value) => value } } });
const { installAnimation } = await import("../../../../packages/expo-windows/src/animation/index.ts");
const turns = (count) => new Promise((resolve) => (function next(left) { left ? requestFrame(() => next(left - 1)) : resolve(); })(count));

test("compositor animations do not start per-frame JS geometry work; page-following JS animations still do", async () => {
  installAnimation();
  let followed = 0;
  const stop = followMotion(() => followed++);
  const native = new Timing();
  native.native = true;
  native.start();
  await turns(3);
  assert.equal(followed, 0);
  native.__notifyAnimationEnd();
  const js = new Timing();
  js.start();
  await turns(3);
  assert.ok(followed > 0);
  js.__notifyAnimationEnd();
  await turns(2);
  stop();
  assert.equal(helper.shouldUseNativeDriver({ useNativeDriver: true }), false);
  assert.equal(helper.shouldUseNativeDriver({ useNativeDriver: true, platformConfig: { useComposition: true } }), false);
});
