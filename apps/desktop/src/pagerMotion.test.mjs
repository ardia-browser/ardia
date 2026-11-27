import assert from "node:assert/strict";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

globalThis.__DEV__ = false;

const spring = await import("./shims/web/motion/pagerSpring.ts");
const { Pager, setPagerClock, NATIVE_FRAME_TIMEOUT } = await import("./shims/web/motion/pager.ts");
const { readPagerFrame, onPagerFrame } = await import("./shims/web/motion/pagerFrames.ts");
const track = await import("./pagerTrack.ts");

const { PagerSpring, TRACKING_SCALE, OMEGA, SETTLE_PERIOD, REST_DISPLACEMENT } = spring;
const ORDER = ["personal", "work", "side"];
const WIDTH = 240;
const FRAME = 1 / 60;

function configured(selected = 0, order = ORDER) {
  const s = new PagerSpring();
  s.configure(order.length, selected, 0, order);
  s.drain();
  return s;
}

function settleFrames(s, start) {
  const positions = [];
  let t = start;
  for (let i = 0; i < 600 && s.phase === "settling"; i++) {
    t += FRAME;
    positions.push(s.stepFrame(t).position);
  }
  return { positions, elapsed: t - start };
}

test("the spring constants match Pager.swift and Wave 2A's PagerSpring", () => {
  assert.equal(TRACKING_SCALE, 0.5);
  assert.equal(SETTLE_PERIOD, 0.25);
  assert.equal(OMEGA, (2 * Math.PI) / 0.25);
  assert.equal(spring.FLICK_VELOCITY, 5);
  assert.equal(spring.RUBBER_DIMENSION, 255);
  assert.equal(spring.RUBBER_COEFFICIENT, 0.15);
  assert.equal(REST_DISPLACEMENT, 0.003);
  assert.equal(spring.REST_SPEED, 0.1);
});

test("a drag tracks the fingers at half speed", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 120, -1, WIDTH, 0.05);
  assert.equal(s.position, (120 * 0.5) / WIDTH);
  assert.equal(s.phase, "tracking");
  const frame = s.drain();
  assert.equal(frame.began, true);
  assert.equal(frame.moved, true);
});

test("dragging past the first profile rubber-bands instead of tracking", () => {
  const s = configured();
  s.input("began", 0, 1, WIDTH, 0);
  s.input("changed", 4 * WIDTH, 1, WIDTH, 0.1);
  assert.ok(s.position < 0);
  assert.ok(s.position > -255 / WIDTH);
  assert.ok(Math.abs(s.position) < (4 * WIDTH * 0.5) / WIDTH);
});

test("a slow release past half a page settles on the next profile, critically damped with no overshoot", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 300, -1, WIDTH, 0.5);
  s.input("ended", 300, -1, WIDTH, 1);
  assert.equal(s.selected, 1);
  assert.equal(s.velocity, 0);
  const frame = s.drain();
  assert.equal(frame.selectedChanged, true);
  assert.equal(frame.needsFrame, true);
  const { positions, elapsed } = settleFrames(s, 1);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 1);
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] >= positions[i - 1] - 1e-12, `frame ${i} moved backwards`);
  assert.ok(positions.every((p) => p <= 1), "the spring overshot");
  assert.ok(elapsed > 0.2 && elapsed < 0.45, `settled in ${elapsed}s`);
});

test("a full-page settle from rest comes to rest in about 0.4 s, not Chrome's 0.9 s snap", () => {
  const s = configured();
  assert.equal(s.switchTo(1), true);
  const { elapsed, positions } = settleFrames(s, 0);
  assert.ok(elapsed > 0.3 && elapsed < 0.45, `settled in ${elapsed}s`);
  assert.ok(positions.every((p) => p <= 1));
  const halfway = positions.findIndex((p) => p >= 0.5);
  assert.ok(halfway > 0 && halfway * FRAME < 0.15);
});

test("the closed-form displacement is critically damped: never crosses the target from rest", () => {
  for (let t = 0; t <= 2; t += 0.001) assert.ok(spring.springDisplacement(1, 0, t) >= 0);
  assert.ok(spring.springDisplacement(1, 0, 0.36) < 0.01);
});

test("a fast flick pages even when the drag is short", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 20, -1, WIDTH, 0.01);
  s.input("changed", 40, -1, WIDTH, 0.02);
  s.input("ended", 40, -1, WIDTH, 0.025);
  assert.equal(s.selected, 1);
});

test("a short slow drag springs home", () => {
  const s = configured(1);
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 60, -1, WIDTH, 0.5);
  s.input("ended", 60, -1, WIDTH, 1);
  assert.equal(s.selected, 1);
  settleFrames(s, 1);
  assert.equal(s.position, 1);
});

test("reduced motion snaps to the target with no frames", () => {
  const s = configured();
  s.setReduceMotion(true);
  s.switchTo(2);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 2);
  const frame = s.drain();
  assert.equal(frame.settled, true);
  assert.equal(frame.needsFrame, false);
});

test("turning reduced motion on mid-settle rests at once", () => {
  const s = configured();
  s.switchTo(1);
  s.stepFrame(0);
  s.stepFrame(FRAME);
  assert.equal(s.phase, "settling");
  s.setReduceMotion(true);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 1);
});

test("prepare holds a settle and abandon finishes it", () => {
  const s = configured();
  s.switchTo(1);
  s.stepFrame(0);
  s.stepFrame(FRAME);
  s.input("prepare", 0, 0, WIDTH, FRAME);
  assert.equal(s.phase, "holding");
  s.input("abandon", 0, 0, WIDTH, FRAME * 2);
  assert.equal(s.phase, "settling");
  settleFrames(s, FRAME * 2);
  assert.equal(s.position, 1);
});

test("an ack older than the pager's own selection never drags it back", () => {
  const s = configured();
  s.switchTo(1);
  settleFrames(s, 0);
  s.configure(ORDER.length, 0, 0, ORDER);
  assert.equal(s.selected, 1);
  s.configure(ORDER.length, 0, s.selectionSequence, ORDER);
  assert.equal(s.selected, 0);
});

test("a reorder while the selection is unacknowledged follows the selected profile", () => {
  const s = configured();
  s.switchTo(1);
  settleFrames(s, 0);
  s.configure(3, 0, 0, ["work", "personal", "side"]);
  assert.equal(s.selectedId(), "work");
  assert.equal(s.selected, 0);
  assert.equal(s.position, 0);
});

function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  let reduce = false;
  const watchers = new Set();
  return {
    clock: {
      now: () => now,
      request: (step) => (pending.set(++id, step), id),
      cancel: (frame) => pending.delete(frame),
      reduceMotion: () => reduce,
      watchReduceMotion: (listener) => (watchers.add(listener), () => watchers.delete(listener)),
    },
    pump(limit = 600) {
      let frames = 0;
      while (pending.size && frames < limit) {
        now += FRAME;
        const steps = [...pending.values()];
        pending.clear();
        for (const step of steps) step(now * 1000);
        frames++;
      }
      return frames;
    },
    advance(seconds) {
      now += seconds;
    },
    setReduce(value) {
      reduce = value;
      for (const listener of watchers) listener();
    },
    get pending() {
      return pending.size;
    },
  };
}

let keys = 0;
function driven(t, order = ORDER, selected = 0) {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => WIDTH, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const pager = Pager.named(`motion-${++keys}`);
  pager.attach(area);
  pager.configure({ key: pager.key, selected, count: order.length, ack: 0, order });
  t.after(() => pager.detach(area));
  return { pager, area, states, positions };
}

test("the JS fallback drives the spring from animation frames and reports the settle", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  assert.equal(pager.switchTo(1, ORDER), true);
  assert.deepEqual(states.map((s) => s.phase), ["selected"]);
  const frames = fake.pump();
  assert.ok(frames >= 20 && frames <= 27, `${frames} frames`);
  assert.equal(positions.at(-1), 1);
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.profileId, "work");
  assert.equal(settled.frames, frames);
  assert.equal(settled.longFrames, 0);
  assert.equal(typeof settled.motion, "number");
  assert.equal(states[0].motion, settled.motion);
  assert.equal(pager.snapshot().phase, "idle");
});

test("reduced motion makes the JS fallback snap without a frame", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  fake.setReduce(true);
  pager.switchTo(2, ORDER);
  assert.equal(fake.pending, 0);
  assert.deepEqual(states.map((s) => s.phase), ["selected", "settled"]);
  assert.equal(positions.at(-1), 2);
});

test("a gesture tracks at half speed through the driver and only from the area that began it", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, positions } = driven(t);
  const other = { ...area, onPosition: () => assert.fail("the other area moved") };
  pager.input(area, "began", 0, -1, 0);
  pager.input(area, "changed", 96, -1, 0.05);
  pager.input(other, "changed", 480, -1, 0.06);
  assert.equal(positions.at(-1), (96 * 0.5) / WIDTH);
  pager.input(area, "ended", 96, -1, 0.5);
  fake.pump();
  assert.equal(pager.snapshot().selected, 0);
});

let frameNumbers = 0;
function nativeFrame(key, fields) {
  return { key, frame: ++frameNumbers, sequence: 1, selectionSequence: 1, phase: "settling", position: 0.5, velocity: 0, selected: 1, count: 3, ...fields };
}

function engine(key, order = ORDER, selected = 0) {
  const spring = new PagerSpring();
  spring.configure(order.length, selected, 0, order);
  spring.drain();
  const toPayload = (f, extra = {}) => ({
    key,
    frame: ++frameNumbers,
    sequence: f.sequence,
    selection_sequence: f.selectionSequence,
    position: f.position,
    velocity: f.velocity,
    phase: f.phase,
    selected: f.selected,
    count: f.count,
    began: f.began,
    selected_changed: f.selectedChanged,
    settled: f.settled,
    detent_crossed: f.detentCrossed,
    ...extra,
  });
  return {
    spring,
    send: (f, extra) => onPagerFrame(toPayload(f, extra)),
    step(t, extra) {
      return onPagerFrame(toPayload(spring.stepFrame(t), extra));
    },
    payload: toPayload,
  };
}

test("every mid-motion frame from Wave 2A's spring arrives, though its sequence only moves on began, selection and rest", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  const native = engine(pager.key);
  native.spring.input("began", 0, -1, WIDTH, 0);
  assert.equal(native.step(0), true);
  const accepted = [];
  for (let k = 1; k <= 6; k++) {
    native.spring.input("changed", k * 40, -1, WIDTH, k * FRAME);
    accepted.push(native.step(k * FRAME));
  }
  assert.deepEqual(accepted, [true, true, true, true, true, true]);
  assert.equal(positions.at(-1), (240 * 0.5) / WIDTH);
  native.spring.input("ended", 240, -1, WIDTH, 0.12);
  let at = 0.12;
  while (native.spring.phase !== "idle") native.step((at += FRAME));
  native.step((at += FRAME));
  assert.equal(fake.pending, 0);
  assert.equal(pager.drivenNatively, false);
  assert.deepEqual(states.map((s) => s.phase), ["began", "selected", "settled"]);
  assert.equal(pager.snapshot().profileId, "work");
  assert.equal(positions.at(-1), 1);
  const sequences = states.map((s) => s.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test("late and repeated native frame numbers are dropped", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  const later = nativeFrame(pager.key, { position: 0.7 });
  const earlier = { ...later, frame: later.frame - 1, position: 0.1 };
  assert.equal(onPagerFrame(later), true);
  assert.equal(onPagerFrame(earlier), false);
  assert.equal(onPagerFrame({ ...later, position: 0.1 }), false);
  assert.equal(positions.at(-1), 0.7);
});

test("a native frame naming a profile is checked against the profile count first, and a diverged order hands the motion to JS", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { count: 2, selected: 1, profileId: "work" })), false);
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(onPagerFrame(nativeFrame(pager.key, { profileId: "gone" })), false);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { phase: "idle", position: 1, settled: true, profileId: "work" })), true);
  assert.equal(pager.snapshot().selected, 1);
  pager.configure({ key: pager.key, selected: 2, count: 3, ack: 0, order: ["side", "personal", "work"] });
  assert.equal(pager.snapshot().selected, 2);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { selectionSequence: 2, position: 0.6, selected: 1, profileId: "work" })), false);
  assert.equal(pager.snapshot().position, 2);
  assert.equal(pager.drivenNatively, false);
});

test("producer to receiver: successive frames, then a reorder and a count change mid-motion", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  const native = engine(pager.key);
  native.spring.switchTo(1);
  let at = 0;
  for (let k = 0; k < 4; k++) assert.equal(native.step((at += FRAME), { profile_id: native.spring.selectedId() }), true);
  const mid = positions.at(-1);
  assert.ok(mid > 0 && mid < 1);
  pager.configure({ key: pager.key, selected: 0, count: 3, ack: 0, order: ["work", "personal", "side"] });
  assert.equal(native.step((at += FRAME), { profile_id: native.spring.selectedId() }), false);
  assert.equal(pager.drivenNatively, false);
  assert.equal(pager.snapshot().profileId, "work");
  assert.ok(Number.isFinite(pager.snapshot().position));
  native.spring.configure(3, 0, 0, ["work", "personal", "side"]);
  native.spring.drain();
  assert.equal(native.step((at += FRAME), { profile_id: native.spring.selectedId() }), false, "the motion from before the reorder stays revoked");
  fake.pump();
  assert.equal(pager.snapshot().position, 0);
  assert.equal(pager.snapshot().profileId, "work");
  native.spring.input("began", 0, -1, WIDTH, at);
  assert.equal(native.step((at += FRAME), { profile_id: native.spring.selectedId() }), true, "a fresh gesture in the new order drives the pager");
  native.spring.input("cancelled", 0, -1, WIDTH, at);
  while (native.spring.phase !== "idle") native.step((at += FRAME));
  pager.configure({ key: pager.key, selected: 0, count: 4, ack: 0, order: ["work", "personal", "side", "new"] });
  native.spring.input("began", 0, -1, WIDTH, at);
  assert.equal(native.step((at += FRAME)), false, "a frame counting three profiles never drives four");
  assert.equal(pager.snapshot().count, 4);
});

test("a late frame from a native settle never undoes a JS switch; a fresh gesture takes native back", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const native = engine(pager.key);
  native.spring.switchTo(1);
  let at = 0;
  native.step((at += FRAME));
  native.step((at += FRAME));
  assert.equal(pager.drivenNatively, true);
  pager.switchTo(2, ORDER);
  assert.equal(pager.snapshot().selected, 2);
  assert.equal(native.step((at += FRAME)), false);
  while (native.spring.phase !== "idle") assert.equal(native.step((at += FRAME)), false);
  assert.equal(pager.snapshot().selected, 2);
  fake.pump();
  assert.equal(pager.snapshot().position, 2);
  native.spring.configure(3, 2, 99, ORDER);
  native.spring.drain();
  native.spring.input("began", 0, 1, WIDTH, at);
  assert.equal(native.step((at += FRAME)), true);
  assert.equal(pager.drivenNatively, true);
});

test("after a JS takeover only a valid new native gesture takes the pager back, never the old gesture's release", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const native = engine(pager.key);
  native.spring.input("began", 0, -1, WIDTH, 0);
  native.spring.input("changed", 300, -1, WIDTH, 0.05);
  assert.equal(native.step(0.05), true);
  assert.equal(pager.snapshot().phase, "tracking");
  pager.switchTo(2, ORDER);
  native.spring.input("ended", 300, -1, WIDTH, 0.3);
  let at = 0.3;
  assert.equal(native.spring.selected, 1);
  assert.equal(native.step((at += FRAME)), false, "the release frame advances the selection sequence but stays revoked");
  while (native.spring.phase !== "idle") assert.equal(native.step((at += FRAME)), false);
  fake.pump();
  assert.equal(pager.snapshot().selected, 2);
  assert.equal(pager.snapshot().position, 2);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { selectionSequence: 50, phase: "settling", position: 1.5, selected: 1, selected_changed: true })), false);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { began: true, phase: "tracking", count: 2, selected: 1, position: 1.4 })), false, "a wrong-count began is rejected");
  assert.equal(onPagerFrame(nativeFrame(pager.key, { phase: "settling", position: 1.2, selected: 1 })), false, "and does not clear the revocation");
  assert.equal(onPagerFrame(nativeFrame(pager.key, { began: true, phase: "tracking", position: 1.9, selected: 2 })), true);
  assert.equal(pager.drivenNatively, true);
});

test("an idle native selection with no settled flag moves the position to the selected page", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  const native = engine(pager.key);
  assert.equal(native.spring.select("side", ORDER), true);
  const frame = native.spring.drain();
  assert.equal(frame.phase, "idle");
  assert.equal(frame.settled, false);
  assert.equal(native.send(frame), true);
  assert.equal(pager.snapshot().selected, 2);
  assert.equal(pager.snapshot().position, 2);
  assert.equal(positions.at(-1), 2);
});

test("a native settle arriving while Reduce Motion is already on snaps straight to the target", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  fake.setReduce(true);
  const before = positions.length;
  const native = engine(pager.key);
  native.spring.switchTo(1);
  assert.equal(native.step(FRAME), true);
  assert.deepEqual(positions.slice(before), [1]);
  assert.equal(pager.snapshot().phase, "idle");
  assert.deepEqual(states.map((s) => s.phase), ["selected", "settled"]);
  assert.equal(fake.pending, 0);
  assert.equal(native.step(2 * FRAME), false);
  assert.equal(pager.snapshot().position, 1);
});

test("when native frames stop mid-settle the JS spring takes over and finishes", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pager, states } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { position: 0.4, selected_changed: true }));
  assert.equal(fake.pending, 0);
  fake.advance(NATIVE_FRAME_TIMEOUT + 0.01);
  t.mock.timers.tick(NATIVE_FRAME_TIMEOUT * 1000 + 30);
  assert.equal(pager.drivenNatively, false);
  assert.equal(fake.pending, 1);
  fake.pump();
  assert.equal(pager.snapshot().position, 1);
  assert.equal(states.at(-1).phase, "settled");
});

test("a native hold that stops sending frames is released and settled by the watchdog", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pager, states } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { phase: "holding", position: 0.7, selected_changed: true }));
  assert.equal(pager.snapshot().phase, "holding");
  fake.advance(NATIVE_FRAME_TIMEOUT + 0.01);
  t.mock.timers.tick(NATIVE_FRAME_TIMEOUT * 1000 + 30);
  assert.equal(pager.drivenNatively, false);
  assert.equal(pager.snapshot().phase, "settling");
  fake.pump();
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(pager.snapshot().position, 1);
  assert.equal(states.at(-1).phase, "settled");
});

test("turning Reduce Motion on mid native settle snaps to the target and ignores the rest of that settle", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  const native = engine(pager.key);
  native.spring.switchTo(1);
  let at = 0;
  native.step((at += FRAME));
  native.step((at += FRAME));
  assert.equal(pager.snapshot().phase, "settling");
  fake.setReduce(true);
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(pager.snapshot().position, 1);
  assert.equal(positions.at(-1), 1);
  assert.equal(states.at(-1).phase, "settled");
  assert.equal(fake.pending, 0);
  assert.equal(native.step((at += FRAME)), false);
  assert.equal(pager.snapshot().position, 1);
});

test("a JS command during a native settle takes over from where the native frame left it", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { position: 0.4, selected_changed: true }));
  pager.switchTo(2, ORDER);
  fake.pump(2);
  assert.ok(positions.at(-1) > 0.4 && positions.at(-1) < 1, `${positions.at(-1)}`);
  fake.pump();
  assert.equal(pager.snapshot().position, 2);
});

test("a 500 ms hold before a settle is not counted as a missed frame", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, states } = driven(t);
  pager.switchTo(1, ORDER);
  fake.pump(3);
  pager.input(area, "prepare", 0, 0, fake.clock.now());
  assert.equal(pager.snapshot().phase, "holding");
  fake.advance(0.5);
  fake.pump();
  pager.input(area, "abandon", 0, 0, fake.clock.now());
  fake.pump();
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.longFrames, 0);
  assert.ok(settled.worstGapMs <= 17, `${settled.worstGapMs} ms`);
});

test("a hold that starts with an animation frame already queued is not counted as a missed frame", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, states } = driven(t);
  pager.switchTo(1, ORDER);
  fake.pump(3);
  assert.equal(fake.pending, 1);
  pager.input(area, "prepare", 0, 0, fake.clock.now());
  assert.equal(fake.pending, 0);
  fake.advance(0.5);
  pager.input(area, "abandon", 0, 0, fake.clock.now());
  fake.pump();
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.longFrames, 0);
  assert.ok(settled.worstGapMs <= 17, `${settled.worstGapMs} ms`);
});

test("native pager frames refuse every hostile input and still pass a valid control", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const before = JSON.stringify(pager.snapshot());
  const fields = ["key", "phase", "position", "velocity", "selected", "count", "sequence", "selectionSequence", "frame", "profileId"];
  const numeric = new Set(["position", "velocity", "selected", "count", "sequence", "selectionSequence", "frame"]);
  const legitimate = (field, value) =>
    (field === "profileId" && (value === null || value === undefined)) || (field === "velocity" && value === undefined) || (numeric.has(field) && Number.isFinite(value));
  for (const { id, value } of HOSTILE_VALUES) {
    for (const field of fields) {
      if (legitimate(field, value)) continue;
      const frame = nativeFrame(pager.key, { [field]: value });
      if (readPagerFrame(frame)) assert.ok((field === "key" || field === "profileId") && /^[A-Za-z0-9_.:-]+$/.test(value), `${id} as ${field} passed the reader`);
      onPagerFrame(frame);
      assert.equal(JSON.stringify(pager.snapshot()), before, `${id} as ${field}`);
    }
    assert.equal(onPagerFrame(value), false, `${id} as the payload`);
  }
  for (const bad of [Number.NaN, Infinity, -Infinity]) for (const field of numeric) assert.equal(readPagerFrame(nativeFrame(pager.key, { [field]: bad })), null, `${bad} as ${field}`);
  assert.equal(readPagerFrame(nativeFrame(pager.key, { selected: 3 })), null);
  assert.equal(readPagerFrame(nativeFrame(pager.key, { sequence: 1.5 })), null);
  assert.equal(readPagerFrame(nativeFrame(pager.key, { frame: 0 })), null);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { position: 0.25 })), true);
  assert.equal(pager.snapshot().position, 0.25);
});

test("the track keeps only the previous, current and next pages, plus a page held on screen", () => {
  const pages = ["a", "b", "c", "d", "e"].map((id, slot) => ({ id, slot }));
  assert.deepEqual(track.neighbourPages(pages, "c").map((p) => p.id), ["b", "c", "d"]);
  assert.deepEqual(track.neighbourPages(pages, "a").map((p) => p.id), ["a", "b"]);
  assert.deepEqual(track.neighbourPages(pages, "e").map((p) => p.id), ["d", "e"]);
  assert.deepEqual(track.neighbourPages(pages, "e", "a").map((p) => p.id), ["a", "d", "e"]);
  assert.deepEqual(track.neighbourPages(pages, "missing", "b").map((p) => p.id), ["b"]);
});

test("the track maps pager position to scroll offset with a rubber-band gutter each side", () => {
  assert.equal(track.trackSpan([{ id: "a", slot: 0 }, { id: "b", slot: 1 }, { id: "c", slot: 2 }]), 3);
  assert.equal(track.trackWidth(3, WIDTH), 5 * WIDTH);
  assert.equal(track.pageLeft(0, WIDTH), WIDTH);
  assert.equal(track.trackScrollLeft(0, 3, WIDTH), WIDTH);
  assert.equal(track.trackScrollLeft(1.5, 3, WIDTH), 2.5 * WIDTH);
  assert.equal(track.trackScrollLeft(-0.2, 3, WIDTH), 0.8 * WIDTH);
  assert.equal(track.trackScrollLeft(-5, 3, WIDTH), 0);
  assert.equal(track.trackScrollLeft(9, 3, WIDTH), 4 * WIDTH);
  assert.equal(track.trackScrollLeft(Number.NaN, 3, WIDTH), 0);
});

function sample(frames, progress) {
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (progress <= b.offset) return b.offset === a.offset ? b.opacity : a.opacity + ((progress - a.offset) / (b.offset - a.offset)) * (b.opacity - a.opacity);
  }
  return frames.at(-1).opacity;
}

test("ScrollTimeline tint keyframes reproduce the position-driven tint at every scroll offset", () => {
  for (const span of [2, 3, 7]) {
    for (let slot = 0; slot < span; slot++) {
      const frames = track.tintKeyframes(slot, span);
      assert.equal(frames[0].offset, 0);
      assert.equal(frames.at(-1).offset, 1);
      for (let i = 1; i < frames.length; i++) assert.ok(frames[i].offset >= frames[i - 1].offset);
      for (let position = -1; position <= span; position += 0.05) {
        const progress = track.trackProgress(position, span);
        assert.ok(Math.abs(sample(frames, progress) - track.tintOpacity(position, slot)) < 1e-9, `span ${span} slot ${slot} at ${position}`);
      }
    }
  }
  assert.equal(track.tintFallbackOpacity(0, "--p"), "1");
  assert.equal(track.tintFallbackOpacity(2, "--p"), "clamp(0, calc(var(--p) - 1), 1)");
});

test("over behind-window glass a settled profile draws only its own translucent tint, so every profile reads alike", () => {
  const alpha = 0.508;
  const shown = (position, span) => {
    const blend = { crossfade: true, last: span - 1 };
    return 1 - Array.from({ length: span }, (_, slot) => 1 - alpha * track.tintOpacity(position, slot, blend)).reduce((a, b) => a * b, 1);
  };
  for (const span of [3, 5]) {
    for (let slot = 0; slot < span; slot++) assert.ok(Math.abs(shown(slot, span) - alpha) < 1e-12, `span ${span} settled at ${slot}`);
    for (let position = 0; position <= span - 1; position += 0.05) {
      const blend = { crossfade: true, last: span - 1 };
      const visible = Array.from({ length: span }, (_, slot) => track.tintOpacity(position, slot, blend)).filter((value) => value > 1e-9);
      assert.ok(visible.length <= 2, `only the two neighbours show at ${position}`);
      const total = Array.from({ length: span }, (_, slot) => track.tintOpacity(position, slot, blend)).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `the neighbours' weights sum to one at ${position}, so the additive blend never dips or stacks`);
    }
  }
  const ladder = (position) => 1 - [0, 1, 2].map((slot) => 1 - alpha * track.tintOpacity(position, slot)).reduce((a, b) => a * b, 1);
  assert.ok(ladder(2) > alpha + 0.3, "the opaque ladder would stack translucent tints");
  const edges = { crossfade: true, last: 2 };
  assert.equal(track.tintOpacity(-0.6, 0, edges), 1, "overscroll before the first profile keeps its tint");
  assert.equal(track.tintOpacity(2.6, 2, edges), 1, "overscroll past the last profile keeps its tint");
  for (const span of [1, 2, 3, 7]) {
    const blend = { crossfade: true, last: span - 1 };
    for (let slot = 0; slot < span; slot++) {
      const frames = track.tintKeyframes(slot, span, blend);
      assert.equal(frames[0].offset, 0);
      assert.equal(frames.at(-1).offset, 1);
      for (let position = -1; position <= span; position += 0.05) {
        assert.ok(Math.abs(sample(frames, track.trackProgress(position, span)) - track.tintOpacity(position, slot, blend)) < 1e-9, `span ${span} slot ${slot} at ${position}`);
      }
    }
  }
  assert.equal(track.tintFallbackOpacity(1, "--p", { crossfade: true, last: 2 }), "clamp(0, min(calc(1 + var(--p) - 1), calc(1 - var(--p) + 1)), 1)");
  assert.equal(track.tintFallbackOpacity(0, "--p", { crossfade: true, last: 2 }), "clamp(0, calc(1 - var(--p) + 0), 1)");
  assert.equal(track.tintFallbackOpacity(2, "--p", { crossfade: true, last: 2 }), "clamp(0, calc(1 + var(--p) - 2), 1)");
  assert.equal(track.tintFallbackOpacity(0, "--p", { crossfade: true, last: 0 }), "1");
});

test("swiping between two identical profiles over glass keeps the tint's exact colour and alpha at every fraction", () => {
  const blend = { crossfade: true, last: 1 };
  const additive = (position, tints) => {
    const sum = [0, 0, 0, 0];
    tints.forEach(([r, g, b, a], slot) => {
      const weight = track.tintOpacity(position, slot, blend);
      [r * a, g * a, b * a, a].forEach((value, i) => (sum[i] += weight * value));
    });
    const alpha = Math.min(1, sum[3]);
    return [sum[0] / alpha, sum[1] / alpha, sum[2] / alpha, alpha];
  };
  for (const alpha of [0.854, 0.508]) {
    const tint = [0.36, 0.7, 0.57, alpha];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [r, g, b, a] = additive(t, [tint, tint]);
      assert.ok(Math.abs(a - alpha) < 1e-12, `alpha ${alpha} holds at ${t}`);
      assert.ok([r, g, b].every((value, i) => Math.abs(value - tint[i]) < 1e-12), `colour holds at ${t}`);
    }
    const sourceOver = 1 - (1 - 0.5 * alpha) ** 2;
    assert.ok(sourceOver < alpha - 0.05, "plain stacking would dip mid-swipe");
  }
  const half = additive(0.5, [[1, 0, 0, 0.5], [0, 0, 1, 0.5]]);
  assert.deepEqual(half.map((v) => +v.toFixed(6)), [0.5, 0, 0.5, 0.5], "different neighbours blend linearly");
});

test("over glass the tint layers add inside one isolated group, and a window with one profile runs no timeline", async () => {
  const { readFileSync } = await import("node:fs");
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  assert.match(tint, /export const ISOLATED = \{ isolation: "isolate" \} as const;/);
  assert.match(tint, /export const ADDITIVE = \{ mixBlendMode: "plus-lighter" \} as const;/);
  assert.match(tint, /style=\{\[StyleSheet\.absoluteFill, crossfade \? \(ISOLATED as object\) : null\]\}/);
  assert.match(tint, /\{ willChange: "opacity" \} as object, crossfade \? \(ADDITIVE as object\) : null\]/);
  assert.match(tint, /if \(last <= 0 \|\| \(!crossfade && slot <= 0\)\) \{\n\s*element\.style\.opacity = "1";\n\s*return;/);
});

test("the window tint cross-fades only where native glass sits behind it, and keeps the opaque ladder elsewhere", async () => {
  const { readFileSync } = await import("node:fs");
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  assert.match(tint, /const \[crossfade\] = useState\(behindWindowGlassAvailable\);/);
  assert.match(tint, /const last = trackSpan\(pages\) - 1;/);
  assert.match(tint, /tintKeyframes\(slot, track\.span, blend\)/);
  assert.match(tint, /tintFallbackOpacity\(slot, PAGER_POSITION_VARIABLE, blend\)/);
});

test("a neighbour pre-scrolls so its selected row arrives centred, and stays put when already there", () => {
  const spot = { listTop: 12, rowTop: 130 * 32, rowHeight: 32, viewport: 600, scrollY: 0 };
  const target = track.revealOffset(spot);
  assert.equal(target, Math.round(12 + 130 * 32 + 16 - 300));
  assert.equal(track.revealOffset({ ...spot, scrollY: target }), null);
  assert.equal(track.revealOffset({ ...spot, rowTop: 0 }), null);
  assert.equal(track.revealOffset({ ...spot, viewport: 0 }), null);
});

test("the track registry tells tint layers when the scroller appears and goes", () => {
  const seen = [];
  const scroller = {};
  const stop = track.watchPagerTrack("w-track", (t) => seen.push(t));
  track.setPagerTrack("w-track", { scroller, span: 3 });
  track.setPagerTrack("w-track", { scroller, span: 3 });
  track.setPagerTrack("w-track", null);
  stop();
  track.setPagerTrack("w-track", { scroller, span: 3 });
  assert.deepEqual(seen.map((t) => t?.span ?? null), [null, 3, null]);
  track.setPagerTrack("w-track", null);
});

test("a 0 to 5 jump across six profiles keeps every slot the slide passes through mounted until it rests", () => {
  const pages = ["a", "b", "c", "d", "e", "f"].map((id, slot) => ({ id, slot }));
  const slots = (list) => list.map((page) => page.slot);
  assert.deepEqual(slots(track.neighbourPages(pages, "f", "a")), [0, 4, 5]);
  let travel = track.widenTravel(null, 0, 5);
  assert.deepEqual(slots(track.neighbourPages(pages, "f", "a", travel)), [0, 1, 2, 3, 4, 5]);
  for (const position of [0.4, 1.7, 2.5, 3.9, 4.6]) {
    travel = track.widenTravel(travel, position, 5);
    const mounted = track.neighbourPages(pages, "f", null, travel);
    for (const slot of [Math.floor(position), Math.ceil(position)]) assert.ok(slots(mounted).includes(slot), `slot ${slot} at ${position}`);
    assert.ok(track.coversTravel(mounted, track.travelRange(position, 5)));
  }
  assert.equal(track.widenTravel(travel, 5, 5), null);
  assert.deepEqual(slots(track.neighbourPages(pages, "f", null, null)), [4, 5]);
  assert.equal(track.coversTravel(track.neighbourPages(pages, "f"), track.travelRange(2.5, 5)), false);
});

test("a gesture dragged past the neighbours mounts the slots it reaches", () => {
  const pages = ["a", "b", "c", "d"].map((id, slot) => ({ id, slot }));
  const travel = track.widenTravel(null, -0.3, 0);
  assert.deepEqual(track.neighbourPages(pages, "a", null, travel).map((p) => p.slot), [0, 1]);
  assert.deepEqual(track.travelRange(1.2, 3), { lo: 1, hi: 3 });
});

test("a neighbour whose viewport is measured after it mounts still pre-scrolls to its selected row", () => {
  const scrolled = [];
  const spot = { viewport: 0, scrollY: 0, regions: { list: 40, pinnedGroups: 0 }, scroller: { scrollTo: (to) => scrolled.push(to) } };
  const spots = new Map();
  const queue = new track.RevealQueue();
  const row = () => ({ section: "list", top: 130 * 32, height: 32, listHeight: 150 * 32 });
  const attempt = (id) => track.revealRow(spots.get(id), row, 12);
  queue.want(["work"]);
  assert.equal(queue.pump(attempt), 1, "not mounted yet");
  spots.set("work", spot);
  assert.equal(queue.pump(attempt), 1, "mounted, viewport still 0");
  assert.deepEqual(scrolled, []);
  spot.viewport = 600;
  assert.equal(queue.pump(attempt), 0);
  assert.deepEqual(scrolled, [{ y: Math.round(12 + 40 + 130 * 32 + 16 - 300), animated: false }]);
  queue.want(["work"]);
  spot.scrollY = scrolled[0].y;
  assert.equal(queue.pump(attempt), 0);
  assert.equal(scrolled.length, 1, "already in place");
  queue.want(["side"]);
  spots.set("side", { ...spot, scroller: { scrollTo: () => assert.fail("no selected row") } });
  assert.equal(queue.pump((id) => track.revealRow(spots.get(id), () => null, 12)), 0);
});

test("a neighbour measured before its lazy rows exist keeps waiting until the selected row can be reached", () => {
  const scrolled = [];
  const node = { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
  const spot = { viewport: 600, scrollY: 0, regions: { list: 40 }, scroller: { getScrollableNode: () => node, scrollTo: (to) => { scrolled.push(to.y); node.scrollTop = Math.min(to.y, node.scrollHeight - node.clientHeight); } } };
  const queue = new track.RevealQueue();
  const attempt = () => track.revealRow(spot, () => ({ section: "list", top: 130 * 32, height: 32, listHeight: 150 * 32 }), 12);
  const target = Math.round(12 + 40 + 130 * 32 + 16 - 300);
  queue.want(["work"]);
  assert.equal(queue.pump(attempt), 1);
  assert.deepEqual(scrolled, []);
  node.scrollHeight = 2000;
  assert.equal(queue.pump(attempt), 1, "rows still short of the selection");
  node.scrollHeight = 150 * 32 + 200;
  assert.equal(queue.pump(attempt), 0);
  assert.deepEqual(scrolled, [target]);
  assert.equal(node.scrollTop, target);
  queue.want(["work"]);
  assert.equal(queue.pump(attempt), 0);
  assert.deepEqual(scrolled, [target], "reads the live scroll offset and leaves it");
});

test("the tint uses a ScrollTimeline only with a track, the constructor and element.animate together", () => {
  const Timeline = function () {};
  const element = { animate() {} };
  const live = { scroller: {}, span: 3 };
  assert.equal(track.supportsScrollTimeline(live, element, Timeline), true);
  assert.equal(track.supportsScrollTimeline(null, element, Timeline), false);
  assert.equal(track.supportsScrollTimeline(live, {}, Timeline), false);
  assert.equal(track.supportsScrollTimeline(live, element, undefined), false);
  assert.equal(track.supportsScrollTimeline(live, null, Timeline), false);
  assert.equal(track.seededPosition(() => 1.5, 2), 1.5);
  assert.equal(track.seededPosition(undefined, 2), 2);
  assert.equal(track.seededPosition(() => Number.NaN, 2), 2);
});

test("a fast flick released just short of the target settles without overshoot", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 1.8 * WIDTH * 0.5, -1, WIDTH, 0.04);
  s.input("changed", 1.8 * WIDTH, -1, WIDTH, 0.08);
  assert.ok(Math.abs(s.position - 0.9) < 1e-9);
  s.input("ended", 1.8 * WIDTH, -1, WIDTH, 0.08);
  assert.equal(s.selected, 1);
  assert.ok(s.velocity > 0 && s.velocity <= OMEGA * 0.1 + 1e-9, `released at ${s.velocity}`);
  const { positions } = settleFrames(s, 0.08);
  assert.ok(positions.every((p) => p <= 1), `overshot to ${Math.max(...positions)}`);
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] >= positions[i - 1] - 1e-12);
});

test("the release velocity bound keeps the closed-form spring on one side of the target", () => {
  assert.equal(spring.overshootFreeVelocity(-0.1, 22.5), OMEGA * 0.1);
  assert.equal(spring.overshootFreeVelocity(-0.1, 1), 1);
  assert.equal(spring.overshootFreeVelocity(0.1, 3), 0);
  assert.equal(spring.overshootFreeVelocity(0, 3), 0);
  assert.equal(spring.overshootFreeVelocity(-0.1, Number.NaN), 0);
  for (const [x0, v] of [[-0.1, 22.5], [-0.5, 40], [0.3, -40], [-1, 3]]) {
    const bounded = spring.overshootFreeVelocity(x0, v);
    for (let t = 0; t <= 2; t += 0.0005) assert.ok(Math.sign(spring.springDisplacement(x0, bounded, t)) !== -Math.sign(x0), `${x0}, ${v} crossed at ${t}`);
  }
});

test("a mismatched native frame during a JS drag is dropped and the drag keeps tracking", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, positions } = driven(t);
  pager.input(area, "began", 0, -1, 0);
  pager.input(area, "changed", 48, -1, 0.02);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { phase: "settling", selected: 1, position: 0.8, profileId: "side" })), false);
  assert.equal(pager.snapshot().phase, "tracking");
  assert.equal(fake.pending, 0);
  pager.input(area, "changed", 96, -1, 0.04);
  assert.equal(positions.at(-1), (96 * 0.5) / WIDTH);
  assert.equal(pager.snapshot().phase, "tracking");
});

test("a remounted pager keeps its sequences above what the window already acknowledged", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const key = `remount-${++keys}`;
  const states = [];
  const area = { pageWidth: () => WIDTH, attached: () => true, onPosition: () => {}, onState: (e) => states.push(e) };
  const first = Pager.named(key);
  first.attach(area);
  first.configure({ key, selected: 0, count: 3, ack: 0, order: ORDER });
  first.switchTo(1, ORDER);
  fake.pump();
  const acked = first.snapshot().selectionSequence;
  const seen = Math.max(...states.map((s) => s.sequence));
  first.detach(area);
  assert.equal(Pager.existing(key), undefined);
  const second = Pager.named(key);
  second.attach(area);
  t.after(() => second.detach(area));
  second.configure({ key, selected: 1, count: 3, ack: acked, order: ORDER });
  assert.ok(second.snapshot().sequence > seen, `${second.snapshot().sequence} after ${seen}`);
  const before = states.length;
  fake.setReduce(true);
  second.switchTo(2, ORDER);
  const fresh = states.slice(before);
  assert.deepEqual(fresh.map((s) => s.phase), ["selected", "settled"]);
  assert.ok(fresh.every((s) => s.sequence > seen && s.profileId === "side"));
  second.configure({ key, selected: 1, count: 3, ack: acked, order: ORDER });
  assert.equal(second.snapshot().selected, 2, "the old ack can't pull the new selection back");
});

test("a fresh spring seeds its sequences past the ack it is configured with", () => {
  const s = new PagerSpring();
  s.configure(3, 1, 40, ORDER);
  assert.ok(s.sequence > 40);
  s.switchTo(2);
  assert.ok(s.selectionSequence > 40);
});

test("a row near the end of a fully loaded list is revealed at the bottom of the scroll range", () => {
  const scrolled = [];
  const node = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 };
  const spot = { viewport: 600, scrollY: 0, regions: { list: 0 }, scroller: { getScrollableNode: () => node, scrollTo: (to) => { scrolled.push(to.y); node.scrollTop = to.y; } } };
  const row = () => ({ section: "list", top: 1916, height: 32, listHeight: 1990 });
  assert.equal(track.centredOffset(0, 1916, 32, 600), 1632);
  assert.equal(track.revealRow(spot, row, 0), "done");
  assert.deepEqual(scrolled, [1400]);
  assert.equal(track.revealRow(spot, row, 0), "done");
  assert.deepEqual(scrolled, [1400], "already as close as the list allows");
  node.scrollHeight = 1200;
  node.scrollTop = 0;
  assert.equal(track.revealRow(spot, row, 0), "wait", "the row itself hasn't mounted yet");
});

test("a row inside an empty viewport waits for the lazy rows before it scrolls to centre", () => {
  const scrolled = [];
  const node = { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
  const spot = { viewport: 600, scrollY: 0, regions: { list: 0 }, scroller: { getScrollableNode: () => node, scrollTo: (to) => { scrolled.push(to.y); node.scrollTop = to.y; } } };
  const queue = new track.RevealQueue();
  const attempt = () => track.revealRow(spot, () => ({ section: "list", top: 324, height: 32, listHeight: 40 * 32 }), 0);
  queue.want(["work"]);
  assert.equal(queue.pump(attempt), 1, "the 600 px viewport is filled before any row mounts");
  assert.deepEqual(scrolled, []);
  node.scrollHeight = 900;
  assert.equal(queue.pump(attempt), 0);
  assert.deepEqual(scrolled, [40]);
  assert.equal(node.scrollTop, 40);
});

test("a short list that is fully laid out reveals its last row without waiting", () => {
  const scrolled = [];
  const node = { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
  const spot = { viewport: 600, scrollY: 0, regions: { list: 0 }, scroller: { getScrollableNode: () => node, scrollTo: (to) => scrolled.push(to.y) } };
  assert.equal(track.revealRow(spot, () => ({ section: "list", top: 324, height: 32, listHeight: 356 }), 0), "done");
  assert.deepEqual(scrolled, []);
});

test("a same-count reorder during a native settle revokes it, so a continuation without profileId can't pick the stale slot", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const native = engine(pager.key);
  native.spring.switchTo(1);
  let at = 0;
  assert.equal(native.step((at += FRAME)), true);
  assert.equal(pager.drivenNatively, true);
  pager.configure({ key: pager.key, selected: 0, count: 3, ack: 0, order: ["side", "work", "personal"] });
  assert.equal(pager.drivenNatively, false);
  assert.equal(pager.snapshot().profileId, "work");
  assert.equal(native.step((at += FRAME)), false);
  assert.equal(pager.snapshot().profileId, "work");
  native.spring.configure(3, 1, 0, ["side", "work", "personal"]);
  native.spring.drain();
  native.spring.input("began", 0, -1, WIDTH, at);
  assert.equal(native.step((at += FRAME)), true, "a fresh gesture is still accepted");
});

test("selecting an unknown profile during a native settle leaves the native motion and its watchdog running", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pager } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { position: 0.4, selected_changed: true }));
  assert.equal(pager.select("gone", ORDER), false);
  assert.equal(pager.drivenNatively, true);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { position: 0.6 })), true);
  fake.advance(NATIVE_FRAME_TIMEOUT + 0.01);
  t.mock.timers.tick(NATIVE_FRAME_TIMEOUT * 1000 + 30);
  assert.equal(pager.drivenNatively, false);
  fake.pump();
  assert.equal(pager.snapshot().position, 1);
});

test("a rejected native frame never moves the frame watermark", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const base = frameNumbers;
  assert.equal(onPagerFrame({ ...nativeFrame(pager.key, { count: 2, selected: 1 }), frame: base + 20 }), false);
  assert.equal(onPagerFrame({ ...nativeFrame(pager.key, { profileId: "gone" }), frame: base + 21 }), false);
  assert.equal(onPagerFrame({ ...nativeFrame(pager.key, { position: 0.3 }), frame: base + 11 }), true);
  assert.equal(pager.snapshot().position, 0.3);
  frameNumbers = base + 30;
});

test("a configure carrying an ack older than the pager's selection keeps that selection, even when the count changes", () => {
  const s = configured();
  s.switchTo(2);
  settleFrames(s, 0);
  const selection = s.selectionSequence;
  s.configure(4, 0, selection - 1, null);
  assert.equal(s.selected, 2);
  assert.equal(s.position, 2);
  s.configure(4, 0, selection - 1, null);
  assert.equal(s.selected, 2);
  s.configure(4, 0, s.selectionSequence, null);
  assert.equal(s.selected, 0, "an ack that has caught up moves the pager");
});

test("a native frame arriving during a local drag is refused and the drag finishes normally", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, positions } = driven(t);
  pager.input(area, "began", 0, -1, 0);
  pager.input(area, "changed", 120, -1, 0.05);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { began: true, phase: "tracking", position: 0.9, selected: 0 })), false);
  assert.equal(pager.drivenNatively, false);
  pager.input(area, "changed", 360, -1, 0.5);
  assert.equal(positions.at(-1), (360 * 0.5) / WIDTH);
  pager.input(area, "ended", 360, -1, 1);
  fake.pump();
  assert.equal(pager.snapshot().selected, 1);
  assert.equal(pager.snapshot().position, 1);
});

test("a native-driven settle reports its frame arrival statistics when it settles", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states } = driven(t);
  const native = engine(pager.key);
  native.spring.switchTo(1);
  let at = 0;
  native.step((at += FRAME));
  let gaps = 0;
  while (native.spring.phase !== "idle") {
    const gap = gaps === 3 ? 0.05 : FRAME;
    fake.advance(gap);
    native.step((at += gap));
    gaps++;
  }
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.frames, gaps);
  assert.equal(settled.longFrames, 1);
  assert.equal(settled.worstGapMs, 50);
});

test("overscroll past either end never asks to mount a slot that doesn't exist", () => {
  assert.deepEqual(track.widenTravel(null, -0.1, 0, 3), { lo: 0, hi: 0 });
  assert.equal(track.widenTravel(null, -2, -1, 3), null);
  const edge = track.widenTravel(null, 2.2, 2, 3);
  assert.deepEqual(edge, { lo: 2, hi: 2 });
  assert.equal(track.widenTravel(edge, 2.4, 2, 3), edge, "unchanged endpoints reuse the same range, so no re-render");
  assert.ok(track.sameTravel(edge, { lo: 2, hi: 2 }));
  const pages = ["a", "b", "c"].map((id, slot) => ({ id, slot }));
  assert.ok(track.coversTravel(track.neighbourPages(pages, "a"), track.widenTravel(null, -0.3, 0, 3)));
});

test("tint layers are set before paint and the track's live ref is written in a layout effect, not during render", async () => {
  const { readFileSync } = await import("node:fs");
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  const trackSource = readFileSync(new URL("./SidebarPagerTrack.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tint, /\buseEffect\b/);
  assert.match(tint, /element\.style\.opacity = String\(tintOpacity\(selectedSlot\(windowId\), slot, blend\)\)/);
  assert.match(trackSource, /useLayoutEffect\(\(\) => \{\n\s*live\.current = \{ home, mounted, travel: renderTravel \};\n\s*\}\);/);
  assert.equal(trackSource.match(/live\.current = /g)?.length, 1);
  assert.ok(trackSource.indexOf("live.current = {") < trackSource.indexOf("const place = "));
});

test("a JS hold followed by a native settle doesn't count the hold as a frame gap", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, states } = driven(t);
  pager.switchTo(1, ORDER);
  fake.pump(3);
  pager.input(area, "prepare", 0, 0, fake.clock.now());
  assert.equal(pager.snapshot().phase, "holding");
  fake.advance(0.5);
  let position = pager.snapshot().position;
  for (let k = 0; k < 4; k++) {
    position = Math.min(1, position + 0.1);
    assert.equal(onPagerFrame(nativeFrame(pager.key, { position, selected: 1 })), true);
    fake.advance(FRAME);
  }
  assert.equal(onPagerFrame(nativeFrame(pager.key, { phase: "idle", position: 1, selected: 1, settled: true })), true);
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.longFrames, 0);
  assert.ok(settled.worstGapMs <= 17, `${settled.worstGapMs} ms`);
});

test("a tint layer that moves to the first slot is made fully opaque", async () => {
  const { readFileSync } = await import("node:fs");
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  assert.match(tint, /if \(last <= 0 \|\| \(!crossfade && slot <= 0\)\) \{\n\s*element\.style\.opacity = "1";\n\s*return;\n\s*\}/);
});
