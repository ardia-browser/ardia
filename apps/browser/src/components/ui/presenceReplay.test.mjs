import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { animations } from "../../test-native/reactNative.ts";
const { usePresence } = await import("./motion.ts");

const MOTION = { show: { duration: 150, easing: (t) => t }, hide: { duration: 200, easing: (t) => t } };

test("an overlay that enters still ends fully shown when its effect is cleaned up and run again, as StrictMode does", () => {
  animations.held = true;
  try {
    const hook = mount(() => usePresence("https://a.test/", MOTION, true));
    assert.equal(hook.value.appear.__getValue(), 0, "it starts hidden and fades in");
    hook.replayEffects();
    animations.finish();
    assert.equal(hook.value.appear.__getValue(), 1);
    assert.equal(hook.value.shown, "https://a.test/");
  } finally {
    animations.held = false;
    animations.running = [];
  }
});

test("a replayed effect leaves an overlay that was already showing where it is, and still fades one out", () => {
  animations.held = true;
  try {
    const hook = mount(({ value }) => usePresence(value, MOTION), { props: { value: "x" } });
    hook.replayEffects();
    assert.equal(animations.running.length, 0, "nothing to animate");
    assert.equal(hook.value.appear.__getValue(), 1);
    hook.rerender({ value: null });
    hook.replayEffects();
    animations.finish();
    assert.equal(hook.value.appear.__getValue(), 0);
    assert.equal(hook.value.shown, null, "it unmounts once the fade out ends");
  } finally {
    animations.held = false;
    animations.running = [];
  }
});
