import assert from "node:assert/strict";
import { test } from "node:test";
import { createCrossfade } from "./crossfadeModel.ts";

function fakeFader() {
  const runs = [];
  const fader = {
    value: 1,
    set(v) {
      fader.value = v;
    },
    run(done) {
      const run = { done, stopped: false };
      runs.push(run);
      return () => (run.stopped = true);
    },
  };
  return { fader, runs };
}

test("a quick A to B to A ends fully shown with nothing leaving, even if the first fade reports late", () => {
  const { fader, runs } = fakeFader();
  const seen = [];
  const fade = createCrossfade("A", "a", fader, (l) => seen.push(l));
  fade.show("B", "b");
  fade.show("A", "a");
  assert.equal(runs[0].stopped, true);
  runs[0].done();
  assert.deepEqual(seen.at(-1), { node: "b", turn: 2 });
  runs[1].done();
  assert.equal(fader.value, 1);
  assert.equal(seen.at(-1), null);
});

test("a stale finish never clears a newer leaving node", () => {
  const { fader, runs } = fakeFader();
  const seen = [];
  const fade = createCrossfade("A", "a", fader, (l) => seen.push(l));
  fade.show("B", "b");
  fade.show("C", "c");
  runs[0].done();
  assert.deepEqual(seen.at(-1), { node: "b", turn: 2 });
  assert.equal(fader.value, 0);
});

test("a new node under the same id swaps without a fade", () => {
  const { fader, runs } = fakeFader();
  const fade = createCrossfade("A", "a", fader, () => assert.fail("no fade"));
  fade.show("A", "a2");
  assert.equal(runs.length, 0);
  assert.equal(fader.value, 1);
});
