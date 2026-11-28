import assert from "node:assert/strict";
import { test } from "node:test";

const { sameData, themeGesture } = await import("./themeGesture.ts");

const look = (intensity) => ({ stops: [{ x: 0.5, y: 0.5, color: { r: 0.5, g: 0.4, b: 0.6, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });

function rig(showing = "p:plum") {
  const applied = [];
  const finals = [];
  const frames = new Map();
  let next = 1;
  const state = { showing, draft: null, current: {} };
  const g = themeGesture({
    apply: (theme, final) => (applied.push([state.showing, theme?.intensity ?? null]), finals.push(final), (state.current = {})),
    showing: () => state.showing,
    current: () => state.current,
    draft: (edit) => void (state.draft = edit),
    requestFrame: (run) => (frames.set(next, run), next++),
    cancelFrame: (handle) => void frames.delete(handle),
  });
  const tick = () => {
    const runs = [...frames.values()];
    frames.clear();
    runs.forEach((run) => run());
  };
  return { g, applied, finals, state, tick, frames };
}

test("a drag writes once a frame and its release lands at once", () => {
  const { g, applied, tick } = rig();
  g.change(look(0.1), "p:plum");
  g.change(look(0.2), "p:plum");
  tick();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.2], ["p:plum", 0.3]]);
});

test("frames during a drag are marked live and only the release is marked final", () => {
  const { g, finals, tick } = rig();
  g.change(look(0.1), "p:plum");
  tick();
  g.change(look(0.2), "p:plum");
  tick();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(finals, [false, false, true]);
});

test("switching presets mid-drag drops the queued frame and the rest of that drag, and the next drag edits the new preset", () => {
  const { g, applied, state, tick } = rig();
  g.change(look(0.1), "p:plum");
  state.showing = "p:blue";
  tick();
  g.change(look(0.2), "p:blue");
  g.change(look(0.3), "p:blue", true);
  assert.deepEqual(applied, [], "nothing from the plum drag reaches blue");
  assert.equal(state.draft, null);
  g.change(look(0.4), "p:blue", true);
  assert.deepEqual(applied, [["p:blue", 0.4]]);
});

test("Reset drops a frame still waiting, so the edit can't come back", () => {
  const { g, applied, state, tick, frames } = rig();
  g.change(look(0.1), "p:plum");
  g.cancel();
  assert.equal(frames.size, 0);
  tick();
  assert.deepEqual(applied, []);
  assert.equal(state.draft, null);
  g.change(look(0.5), "p:plum", true);
  assert.deepEqual(applied, [], "that drag's release doesn't land either");
  g.change(look(0.7), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.7]], "the next gesture works");
});

test("Reset with no drag going leaves the next gesture alone", () => {
  const { g, applied } = rig();
  g.cancel();
  g.change(look(0.4), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.4]]);
});

test("Reset in the middle of a drag keeps the rest of that drag from writing the edit back", () => {
  const { g, applied, tick } = rig();
  g.change(look(0.1), "p:plum");
  g.cancel();
  g.change(look(0.2), "p:plum");
  tick();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [], "neither a move nor the release after Reset lands");
  g.change(look(0.6), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.6]], "the next gesture works");
});

test("a drag that leaves its preset and comes back during the same drag never writes", () => {
  const { g, applied, state, tick } = rig();
  g.change(look(0.1), "p:plum");
  state.showing = "p:blue";
  g.change(look(0.2), "p:blue");
  state.showing = "p:plum";
  g.change(look(0.3), "p:plum");
  tick();
  g.change(look(0.4), "p:plum", true);
  assert.deepEqual(applied, []);
  g.change(look(0.5), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.5]], "the next gesture works");
});

test("a drag armed at its grant, before any move, is cancelled by Reset through its release", () => {
  const { g, applied, tick } = rig();
  g.begin("p:plum");
  g.cancel();
  g.change(look(0.2), "p:plum");
  tick();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, []);
});

test("a selection change during a drag cancels it for good, even with no event on the other preset", () => {
  const { g, applied, state, tick } = rig();
  g.begin("p:plum");
  g.change(look(0.1), "p:plum");
  state.showing = "p:blue";
  g.selectionChanged();
  state.showing = "p:plum";
  g.selectionChanged();
  tick();
  g.change(look(0.4), "p:plum", true);
  assert.deepEqual(applied, [], "neither the queued frame nor the release lands");
  g.change(look(0.5), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.5]], "the next gesture works");
});

test("a selection change with no drag going leaves the next gesture alone", () => {
  const { g, applied } = rig();
  g.selectionChanged();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.3]]);
});

test("a look changed from outside during a drag, as a command-line reset, cancels the drag's waiting frame and the rest of it", () => {
  const { g, applied, state, tick } = rig();
  g.change(look(0.1), "p:plum");
  state.current = {};
  tick();
  g.change(look(0.2), "p:plum", true);
  assert.deepEqual(applied, []);
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.3]], "the next gesture works");
});

test("a release after an outside change drops the drag and leaves the next gesture working", () => {
  const { g, applied, state } = rig();
  g.change(look(0.1), "p:plum");
  state.current = {};
  g.change(look(0.2), "p:plum", true);
  assert.deepEqual(applied, []);
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.3]], "the next click lands");
});

function echoRig(start) {
  const applied = [];
  const frames = new Map();
  let next = 1;
  const state = { current: start };
  const g = themeGesture({
    apply: (theme) => (applied.push(theme?.angle ?? theme?.intensity ?? null), (state.current = theme)),
    showing: () => "p:plum",
    current: () => state.current,
    same: sameData,
    draft: () => {},
    requestFrame: (run) => (frames.set(next, run), next++),
    cancelFrame: (handle) => void frames.delete(handle),
  });
  const tick = () => {
    const runs = [...frames.values()];
    frames.clear();
    runs.forEach((run) => run());
  };
  return { g, applied, state, tick };
}

test("a drag keeps going when the host hands back the look it just wrote as a new but equal copy", () => {
  const { g, applied, state, tick } = echoRig(look(0.1));
  g.change(look(0.2), "p:plum");
  tick();
  state.current = JSON.parse(JSON.stringify({ ...state.current, dark: undefined }));
  g.change(look(0.3), "p:plum");
  tick();
  state.current = structuredClone(state.current);
  g.change(look(0.4), "p:plum", true);
  assert.deepEqual(applied, [0.2, 0.3, 0.4]);
});

test("an outside edit smaller than the preset-matching tolerance still cancels the drag", async () => {
  const { sameTheme } = await import("./presetLook.ts");
  const { g, applied, state, tick } = echoRig({ ...look(0.5), angle: 146 });
  g.change({ ...look(0.5), angle: 140 }, "p:plum");
  tick();
  const nudged = { ...state.current, angle: 140.25 };
  assert.ok(sameTheme(nudged, state.current), "the tolerant preset match would miss this edit");
  state.current = nudged;
  g.change({ ...look(0.5), angle: 130 }, "p:plum");
  tick();
  g.change({ ...look(0.5), angle: 120 }, "p:plum", true);
  assert.deepEqual(applied, [140]);
});

test("exact theme data equality ignores fields left undefined and nothing else", () => {
  assert.ok(sameData({ a: 1, b: undefined, c: [1, { d: 2 }] }, { c: [1, { d: 2 }], a: 1 }));
  assert.ok(!sameData({ a: 1 }, { a: 1.0001 }));
  assert.ok(!sameData({ a: [1, 2] }, { a: [1] }));
  assert.ok(!sameData({ a: null }, { a: undefined }));
  assert.ok(!sameData(null, undefined));
  assert.ok(sameData(null, null));
});

test("a drag runs with the browser's own requestAnimationFrame, which throws Illegal invocation when called on anything but the window", () => {
  const frames = new Map();
  let next = 1;
  const applied = [];
  function hostRequestFrame(run) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    frames.set(next, run);
    return next++;
  }
  function hostCancelFrame(handle) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    frames.delete(handle);
  }
  let current = {};
  const g = themeGesture({
    apply: (theme) => (applied.push(theme?.intensity ?? null), (current = {})),
    showing: () => "p:plum",
    current: () => current,
    draft: () => {},
    requestFrame: hostRequestFrame,
    cancelFrame: hostCancelFrame,
  });
  g.change(look(0.5), "p:plum");
  g.change(look(0.2), "p:plum");
  [...frames.values()].forEach((run) => run());
  frames.clear();
  g.change(look(0.1), "p:plum");
  g.change(look(0), "p:plum", true);
  assert.deepEqual(applied, [0.2, 0]);
  assert.equal(frames.size, 0);
});
