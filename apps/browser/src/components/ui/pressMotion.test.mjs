import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { Animated, animations } = await import("react-native");
const { reduceMotionKnown } = await import("./reduceMotion.ts");
const { buttonMotion, springs, usePressScaleMotion } = await import("./motion.ts");
const { setPressMotion } = await import("../../lib/pressMotion.ts");

await reduceMotionKnown;

function pressed(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const springsRun = [];
  const spring = Animated.spring;
  Animated.spring = (value, config) => {
    springsRun.push(config);
    return spring(value, config);
  };
  animations.held = true;
  setPressMotion("bounce");
  t.after(() => {
    Animated.spring = spring;
    animations.held = false;
    animations.running = [];
    setPressMotion("still");
  });
  const mounted = mount(() => usePressScaleMotion(true, buttonMotion.iconPressScale));
  t.after(() => mounted.unmount());
  return { motion: () => mounted.value, springsRun };
}

test("a bounce press released before 90 ms keeps dipping until then, then springs back", (t) => {
  const { motion, springsRun } = pressed(t);
  motion().onPressIn();
  const dip = motion().scale.running;
  assert.equal(dip?.to, 0.9);
  t.mock.timers.tick(30);
  motion().onPressOut();
  assert.equal(motion().scale.running, dip, "the dip keeps going through the shortest press");
  t.mock.timers.tick(60);
  assert.equal(motion().scale.running?.to, 1);
  assert.equal(springsRun.at(-1).damping, springs.release.damping);
});

test("a bounce release still pending when pressMotion turns still settles without the bounce", (t) => {
  const { motion, springsRun } = pressed(t);
  motion().onPressIn();
  t.mock.timers.tick(30);
  motion().onPressOut();
  setPressMotion("still");
  t.mock.timers.tick(60);
  assert.equal(motion().scale.running?.to, 1);
  assert.equal(springsRun.at(-1).damping, springs.snappy.damping, "no overshoot once the bounce is off");
});
