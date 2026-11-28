import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_WASH, IDLE_WASH_INPUT, LOAD_WASH, snappedWash, stepWash, washCeiling, washRests, type WashInput, type WashState } from "./loadWash.ts";

const FRAME = 1000 / 60;

const loading = (progress: number, extra: Partial<WashInput> = {}): WashInput => ({ ...IDLE_WASH_INPUT, progress, loading: true, ...extra });

const done = (extra: Partial<WashInput> = {}): WashInput => ({ ...IDLE_WASH_INPUT, progress: 1, loading: false, ...extra });

function run(state: WashState, input: WashInput, ms: number, seen: WashState[] = []): WashState {
  let now = state;
  for (let at = 0; at < ms; at += FRAME) {
    now = stepWash(now, input, FRAME);
    seen.push(now);
  }
  return now;
}

test("a load that ends inside the reveal delay never shows, so a page from the cache doesn't flash the bar", () => {
  const seen: WashState[] = [];
  let state = run(IDLE_WASH, loading(0.3), LOAD_WASH.revealDelayMs - 2 * FRAME, seen);
  state = run(state, done(), 400, seen);
  assert.equal(state.phase, "idle");
  assert.ok(seen.every((frame) => frame.alpha === 0 && !frame.revealed));
});

test("a slower load reveals once, after the delay, and fades the tint in over the fade-in", () => {
  const seen: WashState[] = [];
  const state = run(IDLE_WASH, loading(0.2), LOAD_WASH.revealDelayMs + LOAD_WASH.fadeInMs + 4 * FRAME, seen);
  assert.equal(seen.filter((frame) => frame.revealed).length, 1);
  const revealAt = seen.findIndex((frame) => frame.revealed);
  assert.ok(revealAt * FRAME >= LOAD_WASH.revealDelayMs - FRAME);
  assert.equal(state.alpha, 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.alpha >= seen[i - 1]!.alpha);
});

test("the fill never moves backwards within a load, never overshoots what it chases, and stays under the trickle's ceiling while the page reports little", () => {
  const seen: WashState[] = [];
  let state = run(IDLE_WASH, loading(0.1), 600, seen);
  state = run(state, loading(0.7), 900, seen);
  state = run(state, loading(0.3), 900, seen);
  state = run(state, loading(0.72), 6000, seen);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]!.fill >= seen[i - 1]!.fill, `frame ${i} went back from ${seen[i - 1]!.fill} to ${seen[i]!.fill}`);
    assert.ok(seen[i]!.fill <= seen[i]!.creep + 1e-9, `frame ${i} passed what it chases`);
  }
  assert.ok(state.fill <= LOAD_WASH.trickleCeiling + 1e-9);
  assert.ok(state.fill > 0.72);
});

test("between sparse progress reports the fill keeps creeping, slower and slower, and never passes the ceiling over the real progress", () => {
  const input = loading(0.3);
  let state = run(IDLE_WASH, input, 1000);
  const ceiling = washCeiling(input);
  assert.ok(Math.abs(ceiling - 0.4) < 1e-9);
  const steps: number[] = [];
  for (let second = 0; second < 6; second++) {
    const before = state.fill;
    state = run(state, input, 1000);
    steps.push(state.fill - before);
    assert.ok(state.fill < ceiling);
  }
  assert.ok(steps.every((step) => step > 0));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! < steps[i - 1]!);
});

test("each frame's step is the same whatever the frame rate, so 120 Hz and 60 Hz phones land together", () => {
  const at = (frame: number) => {
    let state = IDLE_WASH;
    for (let ms = 0; ms < 1200; ms += frame) state = stepWash(state, loading(0.5), frame);
    return state.fill;
  };
  assert.ok(Math.abs(at(1000 / 60) - at(1000 / 120)) < 0.01);
});

test("a finished load sweeps to the end on an ease-out, then fades, then rests empty", () => {
  let state = run(IDLE_WASH, loading(0.4), 800);
  const seen: WashState[] = [];
  state = run(state, done(), LOAD_WASH.finishMs + LOAD_WASH.fadeOutMs + 6 * FRAME, seen);
  const sweep = seen.filter((frame) => frame.phase === "finishing");
  assert.ok(sweep.length * FRAME <= LOAD_WASH.finishMs + 2 * FRAME);
  const steps = sweep.slice(1).map((frame, i) => frame.fill - sweep[i]!.fill);
  assert.ok(steps.every((step) => step > 0));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! < steps[i - 1]!);
  const fading = seen.filter((frame) => frame.phase === "fading");
  assert.ok(fading.every((frame) => frame.fill === 1));
  for (let i = 1; i < fading.length; i++) assert.ok(fading[i]!.alpha <= fading[i - 1]!.alpha);
  assert.deepEqual(state, IDLE_WASH);
});

test("a new load during the finish fades out fast under the old fill and starts again from empty, never sliding back in view", () => {
  let state = run(IDLE_WASH, loading(0.5), 800);
  state = run(state, done(), LOAD_WASH.finishMs + 3 * FRAME);
  assert.equal(state.phase, "fading");
  const seen: WashState[] = [];
  state = run(state, loading(0), LOAD_WASH.clearMs + 2 * FRAME, seen);
  for (const frame of seen) if (frame.phase === "clearing") assert.equal(frame.fill, 1);
  for (let i = 1; i < seen.length; i++) if (seen[i]!.fill < seen[i - 1]!.fill) assert.equal(seen[i]!.alpha, 0);
  assert.equal(state.phase, "waiting");
  assert.equal(state.fill < 0.1, true);
  state = run(state, loading(0.1), LOAD_WASH.revealDelayMs + 2 * FRAME);
  assert.equal(state.phase, "showing");
});

test("switching tabs jumps to the shown tab's state at once instead of animating from the last tab's", () => {
  const busy = run(IDLE_WASH, loading(0.8), 1500);
  assert.deepEqual(stepWash(busy, done({ snap: 1 }), FRAME), { ...IDLE_WASH, snap: 1 });
  const switched = stepWash(IDLE_WASH, loading(0.6, { snap: 1 }), FRAME);
  assert.equal(switched.phase, "showing");
  assert.equal(switched.fill, 0.6);
  assert.equal(switched.alpha, 1);
  assert.deepEqual(snappedWash(loading(0.25, { snap: 2, trickles: false })).fill, 0.25);
});

test("a tab shown while its load has barely started waits out the reveal delay like any load, so a new tab opened from search doesn't flash", () => {
  const fresh = stepWash(IDLE_WASH, loading(0, { snap: 1 }), FRAME);
  assert.equal(fresh.alpha, 0);
  const seen: WashState[] = [];
  run(fresh, loading(0.02, { snap: 1 }), LOAD_WASH.revealDelayMs + FRAME, seen);
  assert.equal(seen.filter((frame) => frame.revealed).length, 1);
});

test("a frozen capture holds exactly the frozen share, with no trickle past it", () => {
  const frozen = loading(0.6, { trickles: false, snap: 1 });
  const state = run(snappedWash(frozen), frozen, 5000);
  assert.equal(state.fill, 0.6);
  assert.equal(state.alpha, 1);
});

test("Reduce Motion shows a steady full tint that only fades in and out, with no sweep", () => {
  const seen: WashState[] = [];
  let state = run(IDLE_WASH, loading(0.2, { reduced: true }), 600, seen);
  state = run(state, done({ reduced: true }), LOAD_WASH.fadeOutMs + 4 * FRAME, seen);
  assert.ok(seen.every((frame) => frame.fill === 1 || frame.phase === "idle"));
  assert.ok(!seen.some((frame) => frame.phase === "finishing"));
  assert.equal(state.phase, "idle");
});

test("a stalled frame or a bad progress report never throws the fill off the capsule", () => {
  let state = run(IDLE_WASH, loading(Number.NaN), 400);
  assert.ok(state.fill >= 0 && state.fill <= 1);
  state = stepWash(state, loading(3), 5000);
  assert.ok(state.fill >= 0 && state.fill <= 1);
  state = stepWash(state, loading(3), Number.NaN);
  assert.ok(state.fill >= 0 && state.fill <= 1);
});

test("a load that stalls lets the frame loop rest once the trickle reaches its ceiling, and a new report wakes it", () => {
  const stalled = loading(0.3);
  let state = run(IDLE_WASH, stalled, 400);
  assert.equal(washRests(state, stalled), false);
  state = run(state, stalled, 12_000);
  assert.equal(washRests(state, stalled), true);
  const resumed = loading(0.6);
  assert.equal(washRests(state, resumed), false);
  state = run(state, resumed, 200);
  assert.ok(state.fill > washCeiling(stalled));
});

test("Reduce Motion and a frozen capture rest as soon as the tint is in", () => {
  const reduced = loading(0.4, { reduced: true });
  assert.equal(washRests(run(IDLE_WASH, reduced, LOAD_WASH.revealDelayMs + LOAD_WASH.fadeInMs + 4 * FRAME), reduced), true);
  const frozen = loading(0.4, { trickles: false });
  assert.equal(washRests(run(IDLE_WASH, frozen, 3000), frozen), true);
});

test("a finished load rests only once it is idle, never mid-sweep or mid-fade", () => {
  let state = run(IDLE_WASH, loading(0.5), 1000);
  state = stepWash(state, done(), FRAME);
  assert.equal(washRests(state, done()), false);
  state = run(state, done(), LOAD_WASH.finishMs + LOAD_WASH.fadeOutMs + 4 * FRAME);
  assert.equal(state.phase, "idle");
  assert.equal(washRests(state, done()), true);
});
