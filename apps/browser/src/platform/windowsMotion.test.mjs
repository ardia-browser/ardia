import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrameClock, createMotion } from "../../../../packages/expo-windows/src/animation/motion.ts";

const reported = [];
console.error = (...values) => void reported.push(values);
console.log = () => {};

function display(intervalMs = 1000 / 120) {
  let listener = null;
  let time = 0;
  let requests = 0;
  const source = {
    request: () => void (requests += 1),
    now: () => time,
    onFrame: (listen) => void (listener = listen),
  };
  let wallTime = 0;
  let timers = [];
  const wall = { now: () => wallTime, after: (ms, run) => void timers.push({ at: wallTime + ms, run }) };
  const clock = createFrameClock(() => source, wall);
  const wait = (ms) => {
    wallTime += ms;
    const due = timers.filter((t) => t.at <= wallTime);
    timers = timers.filter((t) => t.at > wallTime);
    for (const t of due) t.run();
  };
  const vsync = (gapMs = intervalMs) => {
    time += gapMs;
    const asked = requests;
    requests = 0;
    if (asked) listener?.({ time, interval: intervalMs });
    return asked > 0;
  };
  const frames = (count, gapMs) => {
    for (let i = 0; i < count; i += 1) vsync(gapMs);
  };
  return { clock, vsync, frames, wait, pending: () => requests, now: () => time };
}

test("a frame callback that throws does not drop the ones after it", () => {
  const { clock, vsync } = display();
  const ran = [];
  reported.length = 0;
  clock.requestFrame(() => {
    throw new Error("first frame fails");
  });
  clock.requestFrame(() => ran.push("second"));
  vsync();
  assert.deepEqual(ran, ["second"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][1].message, "first frame fails");
});

test("a callback cancelled by an earlier one in the same turn does not run", () => {
  const { clock, frames } = display();
  const ran = [];
  let later = 0;
  clock.requestFrame(() => {
    ran.push("first");
    clock.cancelFrame(later);
  });
  later = clock.requestFrame(() => ran.push("cancelled"));
  frames(2);
  assert.deepEqual(ran, ["first"]);
});

test("every callback of a turn gets that display frame's time, one turn per display frame, at any refresh rate", () => {
  for (const hz of [60, 120, 144]) {
    const { clock, vsync, now } = display(1000 / hz);
    const times = [];
    const loop = (time) => {
      times.push(time);
      if (times.length < 6) clock.requestFrame(loop);
    };
    clock.requestFrame(loop);
    clock.requestFrame((time) => assert.equal(time, now()));
    while (vsync());
    assert.equal(times.length, 6);
    for (let i = 1; i < times.length; i += 1) assert.ok(Math.abs(times[i] - times[i - 1] - 1000 / hz) < 1e-9);
  }
});

test("the clock asks the display for one frame at a time and none once nothing waits", () => {
  const { clock, vsync, pending } = display();
  clock.requestFrame(() => {});
  clock.requestFrame(() => {});
  assert.equal(pending(), 1);
  vsync();
  assert.equal(pending(), 0);
  assert.equal(vsync(), false);
});

test("followers run every frame while an animation runs, a burst is reported when it ends, and the clock stops", () => {
  const { clock, frames, pending } = display(1000 / 120);
  const motion = createMotion(clock);
  let follows = 0;
  const bursts = [];
  const unfollow = motion.followMotion(() => follows++);
  const unlisten = motion.onMotionBurst((burst) => bursts.push(burst), () => "");
  const animation = { __active: true };
  motion.noteAnimation(animation);
  frames(6);
  assert.equal(follows, 6);
  assert.equal(bursts.length, 0);
  motion.forgetAnimation(animation);
  frames(2);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].frames, 7);
  assert.equal(bursts[0].milliseconds, Math.round((7 * 1000) / 120));
  assert.equal(bursts[0].long, 0);
  assert.equal(pending(), 0);
  const after = follows;
  frames(4);
  assert.equal(follows, after);
  unfollow();
  unlisten();
});

test("a long frame counts against the display's own interval, not a fixed 60 Hz one", () => {
  const { clock, vsync } = display(1000 / 120);
  const motion = createMotion(clock);
  const bursts = [];
  motion.onMotionBurst((burst) => bursts.push(burst), () => "");
  const animation = { __active: true };
  motion.noteAnimation(animation);
  vsync();
  vsync();
  vsync(30);
  vsync();
  motion.forgetAnimation(animation);
  vsync();
  assert.equal(bursts[0].long, 1, "a 30 ms gap on a 120 Hz display is a long frame");
  assert.equal(bursts[0].longest, 30);
});

test("a burst carries the consent epoch each listener gave when it began, not the one when it ended", () => {
  const { clock, frames } = display();
  const motion = createMotion(clock);
  let epoch = "period-1";
  const bursts = [];
  const unlisten = motion.onMotionBurst((burst) => bursts.push(burst), () => epoch);
  const animation = { __active: true };
  motion.noteAnimation(animation);
  frames(4);
  epoch = "period-2";
  motion.forgetAnimation(animation);
  frames(2);
  unlisten();
  assert.deepEqual(bursts.map((b) => b.epoch), ["period-1"]);
});

test("a follower that throws leaves the clock able to start again", () => {
  const { clock, frames } = display();
  const motion = createMotion(clock);
  reported.length = 0;
  const unfollow = motion.followMotion(() => {
    throw new Error("follower fails");
  });
  const first = { __active: true };
  motion.noteAnimation(first);
  frames(2);
  motion.forgetAnimation(first);
  frames(2);
  unfollow();
  assert.ok(reported.length >= 1);
  let follows = 0;
  const unfollowCount = motion.followMotion(() => follows++);
  const second = { __active: true };
  motion.noteAnimation(second);
  frames(3);
  motion.forgetAnimation(second);
  frames(2);
  unfollowCount();
  assert.ok(follows >= 2, `${follows} follows after a failed follower`);
});

test("a frame the display never sends is asked for again, so one lost frame doesn't stop every animation", () => {
  const { clock, vsync, wait, pending } = display();
  const ran = [];
  clock.requestFrame(() => ran.push("first"));
  assert.equal(pending(), 1);
  wait(100);
  clock.requestFrame(() => ran.push("second"));
  assert.equal(pending(), 1, "no second ask while the first may still come");
  wait(200);
  assert.equal(pending(), 2, "asked again once the display went quiet");
  vsync();
  assert.deepEqual(ran, ["first", "second"]);
  wait(1000);
  assert.equal(pending(), 0, "nothing more to ask for");
});
