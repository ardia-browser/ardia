import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PagerMachine } from "./pagerModel.ts";

const scenarios = JSON.parse(readFileSync(new URL("../tests/fixtures/pager-transitions.json", import.meta.url), "utf8"));
const FRAME = 1 / 120;

function harness() {
  let time = 0;
  let frames = new Map();
  let lastId = 0;
  let reduced = false;
  let motions = 0;
  const states = [];
  const positions = [];
  const clock = {
    now: () => time,
    requestFrame: (frame) => (frames.set(++lastId, frame), lastId),
    cancelFrame: (id) => void frames.delete(id),
    reducedMotion: () => reduced,
    startMotion: () => (motions++, () => {}),
  };
  const pager = new PagerMachine(clock, { position: (page, lead) => positions.push({ page, lead }), state: (event) => states.push(event) });
  const tick = (gap = FRAME) => {
    time += gap;
    const due = [...frames.values()];
    frames.clear();
    for (const frame of due) frame(time);
  };
  return {
    pager,
    states,
    positions,
    tick,
    moving: () => frames.size > 0,
    reduce: (on) => void (reduced = on),
    motions: () => motions,
    resetMotions: () => void (motions = 0),
  };
}

function run(h, step, marks) {
  const { pager } = h;
  if (step.reduceMotion !== undefined) return h.reduce(step.reduceMotion);
  if (step.configure) {
    const { ackOffset, ...config } = step.configure;
    const ack = ackOffset === undefined ? 0 : pager.snapshot().selectionSequence + ackOffset;
    return pager.configure({ ack, leading: false, library: false, ...config });
  }
  if (step.frames !== undefined) {
    for (let i = 0; i < step.frames; i += 1) h.tick(step.gap ?? FRAME);
    return;
  }
  if (step.settle) {
    for (let i = 0; h.moving() && i < 2000; i += 1) h.tick();
    assert.equal(h.moving(), false, "the pages never came to rest");
    return h.resetMotions();
  }
  if (step.expect) return check(h, step.expect, marks);
  if ("track" in step) {
    if (pager.snapshot().phase !== "tracking") pager.beginTracking(() => {});
    return pager.trackTo(step.track);
  }
  const returned =
    "switchTo" in step ? pager.switchTo(step.switchTo, step.order)
    : "step" in step ? pager.step(step.step, step.wrap, step.order)
    : "lead" in step ? pager.lead(step.lead, step.animated ?? true)
    : "select" in step ? pager.select(step.select, step.order)
    : "cancelTracking" in step ? pager.cancelTracking()
    : assert.fail(`unknown step ${JSON.stringify(step)}`);
  if ("returns" in step) assert.equal(returned, step.returns, JSON.stringify(step));
}

function check(h, expect, marks) {
  const states = h.states.slice(marks.states);
  const shown = h.positions.slice(Math.max(0, marks.positions - 1));
  const moved = shown.map(({ page, lead }) => page - lead);
  if (expect.states) assert.deepEqual(states.map((e) => [e.phase, e.selected, e.leading, e.profileId ?? null]), expect.states);
  if (expect.snapshot) {
    const snapshot = h.pager.snapshot();
    for (const [key, value] of Object.entries(expect.snapshot)) assert.deepEqual(snapshot[key] ?? null, value, `snapshot.${key}`);
  }
  if (expect.debug) {
    const debug = h.pager.debug();
    for (const [key, value] of Object.entries(expect.debug)) assert.deepEqual(debug[key] ?? null, value, `debug.${key}`);
  }
  if (expect.moving !== undefined) assert.equal(h.moving(), expect.moving, "moving");
  if (expect.motions !== undefined) assert.equal(h.motions(), expect.motions, "motions started");
  if (expect.smooth !== undefined) {
    for (let i = 1; i < moved.length; i += 1) assert.ok(Math.abs(moved[i] - moved[i - 1]) <= expect.smooth, `jumped from ${moved[i - 1]} to ${moved[i]}`);
  }
  if (expect.pagesStill !== undefined) assert.ok(shown.slice(1).every(({ page }) => page === expect.pagesStill), "the pages moved");
  if (expect.monotonic) for (let i = 1; i < moved.length; i += 1) assert.ok(moved[i] >= moved[i - 1], `went back at ${i}`);
  marks.states = h.states.length;
  marks.positions = h.positions.length;
  h.resetMotions();
}

for (const scenario of scenarios) {
  test(scenario.name, () => {
    const h = harness();
    const marks = { states: 0, positions: 0 };
    for (const step of scenario.steps) run(h, step, marks);
  });
}

