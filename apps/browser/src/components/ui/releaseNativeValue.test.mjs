import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { releaseNativeValue } = await import("./motion.ts");

const fakeValue = (nativeTag) => {
  const calls = [];
  return {
    calls,
    __nativeTag: nativeTag,
    removeAllListeners: () => calls.push("listeners"),
    __detach() {
      calls.push("detach");
      this.__nativeTag = undefined;
    },
  };
};

test("a native value no view holds is detached once, so its native node is dropped", () => {
  const value = fakeValue(7);
  releaseNativeValue(value);
  releaseNativeValue(value);
  assert.deepEqual(value.calls, ["listeners", "detach", "listeners"]);
});

test("a value that never went native, or was already dropped, only loses its listeners", () => {
  const value = fakeValue(undefined);
  releaseNativeValue(value);
  assert.deepEqual(value.calls, ["listeners"]);
});

test("a tab's toolbar motion releases its four values when the tab goes away", () => {
  const motion = readFileSync(new URL("../toolbar/AutoHideToolbar.tsx", import.meta.url), "utf8");
  assert.match(motion, /return \(\) => Object\.values\(v\)\.forEach\(releaseNativeValue\);/);
});
