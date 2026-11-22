import assert from "node:assert/strict";
import { test } from "node:test";

const { themeGesture } = await import("./themeGesture.ts");

const look = (intensity) => ({ stops: [{ x: 0.5, y: 0.5, color: { r: 0.5, g: 0.4, b: 0.6, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });

function rig(showing = "p:plum") {
  const applied = [];
  const frames = new Map();
  let next = 1;
  const state = { showing, draft: null, current: {} };
  const g = themeGesture({
    apply: (theme) => (applied.push([state.showing, theme?.intensity ?? null]), (state.current = {})),
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
  return { g, applied, state, tick, frames };
}

test("a drag writes once a frame and its release lands at once", () => {
  const { g, applied, tick } = rig();
  g.change(look(0.1), "p:plum");
  g.change(look(0.2), "p:plum");
  tick();
  g.change(look(0.3), "p:plum", true);
  assert.deepEqual(applied, [["p:plum", 0.2], ["p:plum", 0.3]]);
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
