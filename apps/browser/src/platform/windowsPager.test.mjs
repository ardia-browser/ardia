import assert from "node:assert/strict";
import { test } from "node:test";
import { PagerRegistry, REST_DISPLACEMENT, springAt } from "../../../../packages/expo-windows/src/pager/pager.ts";
import { stepAction } from "../../../../packages/ardiacore/src/pagerModel.ts";

const FRAME_MS = 1000 / 120;
const MAC_SETTLE_ONE_PAGE_MS = 330;

function harness({ reduced = false } = {}) {
  let time = 0;
  let frames = new Map();
  let lastId = 0;
  let motions = 0;
  let starts = 0;
  const registry = new PagerRegistry({
    now: () => time / 1000,
    requestFrame: (frame) => {
      frames.set(++lastId, frame);
      return lastId;
    },
    cancelFrame: (id) => void frames.delete(id),
    reducedMotion: () => reduced,
    startMotion: () => {
      motions += 1;
      starts += 1;
      return () => void (motions -= 1);
    },
  });
  const positions = [];
  const states = [];
  const area = { position: (p) => (positions.push(p), true), state: (e) => states.push(e) };
  const tick = (ms = FRAME_MS) => {
    time += ms;
    const due = [...frames.values()];
    frames.clear();
    for (const frame of due) frame(time / 1000);
    return due.length > 0;
  };
  const runToRest = (ms = FRAME_MS, limit = 600) => {
    let count = 0;
    while (frames.size && count < limit) tick(ms), (count += 1);
    return count;
  };
  return { registry, positions, states, area, tick, runToRest, elapsed: () => time, moving: () => frames.size > 0, motions: () => motions, starts: () => starts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function configured(h, { selected = 0, count = 3, order = ["a", "b", "c"] } = {}) {
  const pager = h.registry.named("w");
  pager.attach(h.area);
  pager.configure({ selected, count, ack: 0, width: 200, order });
  return pager;
}

test("a switch settles on the target within the Mac's time and never overshoots", async () => {
  const h = harness();
  const pager = configured(h);
  const start = h.positions.length;
  assert.equal(pager.switchTo(1), true);
  const startedAt = h.elapsed();
  h.runToRest();
  const took = h.elapsed() - startedAt;
  const moved = h.positions.slice(start);
  assert.ok(moved.length > 10, `only ${moved.length} frames`);
  assert.ok(took <= MAC_SETTLE_ONE_PAGE_MS + FRAME_MS, `took ${took} ms`);
  assert.equal(moved.at(-1), 1);
  for (let i = 1; i < moved.length; i += 1) assert.ok(moved[i] >= moved[i - 1], `went back at frame ${i}`);
  assert.ok(moved.every((p) => p <= 1), "overshot");
  assert.ok(Math.abs(moved.at(-2) - 1) < REST_DISPLACEMENT * 2);
  assert.equal(h.registry.snapshot("w").phase, "idle");
  assert.equal(h.motions(), 0);
  await flush();
  assert.deepEqual(h.states.map((s) => [s.phase, s.selected]), [["selected", 0], ["selected", 1], ["settled", 1]]);
  assert.equal(h.states.at(-1).profileId, "b");
});

test("motion follows the display's frame times: slow frames do not slow it and a stall lands at once", () => {
  const steady = harness();
  configured(steady).switchTo(2);
  steady.runToRest();
  const slow = harness();
  configured(slow).switchTo(2);
  slow.runToRest(FRAME_MS * 3);
  assert.ok(Math.abs(slow.elapsed() - steady.elapsed()) <= FRAME_MS * 3, `${slow.elapsed()} vs ${steady.elapsed()}`);
  const stalled = harness();
  configured(stalled).switchTo(2);
  stalled.tick(5000);
  assert.equal(stalled.moving(), false, "a five second stall left the pages still moving");
  assert.equal(stalled.positions.at(-1), 2);
});

test("each display frame moves the pages by the time since the switch, at any refresh rate", () => {
  for (const hz of [60, 120, 144]) {
    const h = harness();
    configured(h).switchTo(1);
    h.tick(1000 / hz);
    h.tick(1000 / hz);
    const { offset } = springAt(0, 1, 0, 2 / hz);
    assert.ok(Math.abs(h.positions.at(-1) - (1 + offset)) < 1e-9, `${hz} Hz at ${h.positions.at(-1)}`);
  }
});

test("a new request mid-flight retargets from where the page is, without a jump", () => {
  const h = harness();
  const pager = configured(h, { count: 4, order: ["a", "b", "c", "d"] });
  pager.switchTo(2);
  for (let i = 0; i < 6; i += 1) h.tick();
  const before = h.positions.at(-1);
  const step = before - h.positions.at(-2);
  assert.ok(before > 0.3 && before < 1.9, `at ${before}`);
  pager.switchTo(0);
  h.tick();
  const after = h.positions.at(-1);
  assert.ok(Math.abs(after - before) <= Math.abs(step) * 2 + 0.05, `jumped from ${before} to ${after}`);
  h.runToRest();
  assert.equal(h.positions.at(-1), 0);
  assert.equal(h.registry.snapshot("w").selected, 0);
});

test("targets clamp to the page range and steps stop at the ends unless they wrap", () => {
  const h = harness();
  const pager = configured(h);
  pager.switchTo(9);
  h.runToRest();
  assert.equal(h.registry.snapshot("w").selected, 2);
  assert.equal(h.positions.at(-1), 2);
  pager.switchTo(-4);
  h.runToRest();
  assert.equal(h.registry.snapshot("w").selected, 0);
  assert.equal(pager.step(-1, false), true);
  assert.equal(h.moving(), false);
  assert.equal(pager.step(-1, true), true);
  h.runToRest();
  assert.equal(h.registry.snapshot("w").selected, 2);
});

test("the sequence rises on every selection and every settle", async () => {
  const h = harness();
  const pager = configured(h);
  const first = h.registry.snapshot("w").sequence;
  pager.switchTo(1);
  const selected = h.registry.snapshot("w");
  assert.ok(selected.sequence > first);
  assert.equal(selected.selectionSequence, selected.sequence);
  h.runToRest();
  const settled = h.registry.snapshot("w").sequence;
  assert.ok(settled > selected.sequence);
  pager.switchTo(2);
  h.runToRest();
  await flush();
  const sequences = h.states.map((s) => s.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
  assert.equal(new Set(sequences).size, sequences.length);
});

test("an unconfigured or missing pager refuses, so the app falls back", () => {
  const h = harness();
  assert.equal(h.registry.existing("w"), null);
  const pager = h.registry.named("w");
  assert.equal(pager.switchTo(1), false);
  assert.equal(pager.step(1, false), false);
  assert.equal(pager.select("a", ["a"]), false);
});

test("an outside selection jumps at once and answers with a higher sequence", async () => {
  const h = harness();
  const pager = configured(h);
  const before = h.registry.snapshot("w").sequence;
  assert.equal(pager.select("c", ["a", "b", "c"]), true);
  assert.equal(h.positions.at(-1), 2);
  assert.equal(h.moving(), false);
  const snapshot = h.registry.snapshot("w");
  assert.ok(snapshot.sequence > before);
  assert.equal(snapshot.profileId, "c");
  assert.equal(pager.select("z", ["a", "b", "c"]), false);
  await flush();
  assert.deepEqual(h.states.map((s) => [s.phase, s.profileId]), [["selected", "a"], ["selected", "c"]]);
});

test("props catch up only once the app has acknowledged the pager's own selection", () => {
  const h = harness();
  const pager = configured(h);
  pager.switchTo(1);
  h.runToRest();
  const { selectionSequence } = h.registry.snapshot("w");
  pager.configure({ selected: 0, count: 3, ack: selectionSequence - 1, width: 200, order: ["a", "b", "c"] });
  assert.equal(h.registry.snapshot("w").selected, 1);
  pager.configure({ selected: 2, count: 3, ack: selectionSequence, width: 200, order: ["a", "b", "c"] });
  assert.equal(h.registry.snapshot("w").selected, 2);
  assert.equal(h.positions.at(-1), 2);
});

test("with animations off the pager lands at once and still reports the settle", async () => {
  const h = harness({ reduced: true });
  const pager = configured(h);
  assert.equal(pager.switchTo(2), true);
  assert.equal(h.moving(), false);
  assert.equal(h.positions.at(-1), 2);
  await flush();
  assert.deepEqual(h.states.map((s) => s.phase), ["selected", "selected", "settled"]);
});

test("position goes to one area, state to all, and the last area out forgets the pager", async () => {
  const h = harness();
  const pager = configured(h);
  const second = { positions: [], states: [] };
  const secondArea = { position: (p) => (second.positions.push(p), true), state: (e) => second.states.push(e) };
  pager.attach(secondArea);
  assert.deepEqual(second.positions, [0]);
  pager.switchTo(1);
  h.runToRest();
  await flush();
  assert.equal(second.positions.length, 1);
  assert.equal(second.states.length, h.states.length - 1);
  pager.detach(h.area);
  assert.equal(h.registry.existing("w"), pager);
  pager.switchTo(0);
  h.tick();
  assert.ok(second.positions.length > 1);
  pager.detach(secondArea);
  assert.equal(h.registry.existing("w"), null);
  assert.equal(h.registry.snapshot("w"), null);
  assert.equal(h.moving(), false);
});

function withLibrary(h, selected = 0) {
  const pager = h.registry.named("w");
  const leads = [];
  pager.attach({ position: (p, lead) => (h.positions.push(p), leads.push(lead), true), state: (e) => h.states.push(e) });
  pager.configure({ selected, count: 3, ack: 0, width: 200, order: ["a", "b", "c"], leading: true, library: false });
  return { pager, leads };
}

test("the Library opens from a later profile while the pages hold still, and closing returns to that profile", async () => {
  const h = harness();
  const { pager, leads } = withLibrary(h, 1);
  const start = h.positions.length;
  assert.equal(pager.lead(true), true);
  h.runToRest();
  assert.ok(h.positions.slice(start).every((p) => p === 1), "pages moved while the Library opened");
  assert.equal(leads.at(-1), 1);
  const open = h.registry.snapshot("w");
  assert.deepEqual([open.selected, open.position, open.leading, open.lead, open.profileId], [-1, 0, true, 1, null]);
  assert.equal(pager.lead(false), true);
  h.runToRest();
  const closed = h.registry.snapshot("w");
  assert.deepEqual([closed.selected, closed.position, closed.leading, closed.lead, closed.profileId], [1, 1, false, 0, "b"]);
  await flush();
  assert.deepEqual(h.states.map((s) => [s.phase, s.selected, s.leading]), [["selected", 1, false], ["selected", -1, true], ["settled", -1, true], ["selected", 1, false], ["settled", 1, false]]);
});

test("a selection at the Library re-anchors it over the chosen profile, and a switch closes onto another", async () => {
  const h = harness();
  const { pager } = withLibrary(h);
  pager.lead(true);
  h.runToRest();
  assert.equal(pager.select("c", ["a", "b", "c"]), true);
  assert.equal(h.positions.at(-1), 2);
  assert.deepEqual([pager.debug().anchor, pager.debug().home, h.registry.snapshot("w").leading], [2, 2, true]);
  assert.equal(pager.switchTo(1), true);
  h.runToRest();
  const settled = h.registry.snapshot("w");
  assert.deepEqual([settled.selected, settled.leading, settled.profileId, pager.debug().anchor], [1, false, "b", null]);
});

test("a step back from the first profile opens the Library only where the pager has one", () => {
  const h = harness();
  const { pager } = withLibrary(h);
  assert.equal(pager.step(-1, false), true);
  h.runToRest();
  assert.deepEqual([h.registry.snapshot("w").selected, h.registry.snapshot("w").leading], [-1, true]);
  const plain = harness();
  const without = configured(plain);
  assert.equal(without.step(-1, false), true);
  assert.equal(without.lead(true), false);
  assert.deepEqual([plain.registry.snapshot("w").selected, plain.registry.snapshot("w").phase], [0, "idle"]);
});

test("Previous and Next Profile with the Library open page from the profile the Library opened on", async () => {
  for (const [delta, landing] of [[-1, "a"], [1, "c"]]) {
    const h = harness();
    const { pager } = withLibrary(h, 1);
    pager.lead(true);
    h.runToRest();
    assert.equal(pager.step(delta, true, ["a", "b", "c"]), true);
    h.runToRest();
    const done = h.registry.snapshot("w");
    assert.deepEqual([done.leading, done.profileId], [false, landing]);
  }
});

test("stepAction wraps from the Library's own profile", () => {
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, -1, true), { kind: "switch", index: 0 });
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, 1, true), { kind: "switch", index: 2 });
  assert.deepEqual(stepAction({ anchor: null, selected: 0, leading: true, count: 1 }, 1, true), { kind: "stay" });
});

test("turning off the leading page at the Library settles home once, however often it is configured", () => {
  const h = harness();
  const { pager } = withLibrary(h, 1);
  pager.lead(true);
  h.runToRest();
  const off = { selected: 1, count: 3, ack: 0, width: 200, order: ["a", "b", "c"], leading: false, library: false };
  pager.configure(off);
  const started = h.starts();
  h.tick();
  pager.configure(off);
  pager.configure(off);
  assert.equal(h.starts(), started);
  h.runToRest();
  const done = h.registry.snapshot("w");
  assert.deepEqual([done.leading, done.profileId, pager.debug().anchor], [false, "b", null]);
});

test("turning off the leading page while the Library closes lets the close run on without a restart", () => {
  const h = harness();
  const { pager } = withLibrary(h, 1);
  pager.lead(true);
  h.runToRest();
  pager.lead(false);
  for (let i = 0; i < 4; i += 1) h.tick();
  const started = h.starts();
  pager.configure({ selected: 1, count: 3, ack: 0, width: 200, order: ["a", "b", "c"], leading: false, library: false });
  assert.equal(h.starts(), started);
  h.runToRest();
  const done = h.registry.snapshot("w");
  assert.deepEqual([done.leading, done.profileId, pager.debug().anchor], [false, "b", null]);
});

test("a pager configured while the Library is open starts on the Library and says so", async () => {
  const h = harness();
  const pager = h.registry.named("w");
  pager.attach(h.area);
  pager.configure({ selected: 1, count: 3, ack: 0, width: 200, order: ["a", "b", "c"], leading: true, library: true });
  const snapshot = h.registry.snapshot("w");
  assert.deepEqual([snapshot.selected, snapshot.leading, snapshot.lead, pager.debug().home], [-1, true, 1, 1]);
  await flush();
  assert.deepEqual(h.states.map((e) => [e.leading, e.selected]), [[true, -1]]);
});

test("a first configure reports the profile it starts on", async () => {
  const h = harness();
  configured(h, { selected: 2 });
  await flush();
  assert.deepEqual(h.states.map((e) => [e.phase, e.selected, e.leading, e.profileId]), [["selected", 2, false, "c"]]);
});

test("the library prop with a new selection lands on the Library over that profile", () => {
  const h = harness();
  const { pager } = withLibrary(h);
  pager.configure({ selected: 2, count: 3, ack: 0, width: 200, order: ["a", "b", "c"], leading: true, library: true });
  assert.deepEqual([h.registry.snapshot("w").leading, pager.debug().home], [true, 2]);
});

test("the library prop with a reorder ends on the Library", () => {
  const h = harness();
  const { pager } = withLibrary(h);
  pager.configure({ selected: 1, count: 3, ack: 0, width: 200, order: ["b", "a", "c"], leading: true, library: true });
  h.runToRest();
  assert.deepEqual([h.registry.snapshot("w").leading, pager.debug().home], [true, 1]);
});
