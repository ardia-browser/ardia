import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrameQueue } from "../../../../packages/expo-windows/src/animation/frameQueue.ts";

function fixture() {
  const requested = [], cancelled = [], errors = [];
  let emit;
  const queue = createFrameQueue(() => 100, (error) => errors.push(error));
  queue.useDriver({ requestFrame: (id) => (requested.push(id), true), cancelFrame: (id) => cancelled.push(id), listen: (fn) => (emit = fn, () => {}) });
  return { queue, requested, cancelled, errors, emit: (...args) => emit(...args) };
}

test("callbacks share one native pulse, and callbacks requested during dispatch wait for the next pulse", () => {
  const f = fixture(), seen = [];
  f.queue.request(() => { seen.push("a"); f.queue.request(() => seen.push("next")); assert.equal(f.requested.length, 1); });
  f.queue.request(() => seen.push("b"));
  assert.equal(f.requested.length, 1);
  f.emit(f.requested[0]);
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(f.requested.length, 2);
  f.emit(f.requested[1]);
  assert.deepEqual(seen, ["a", "b", "next"]);
  assert.equal(f.requested.length, 2);
});

test("a queued pulse from a cancelled generation cannot consume its replacement", () => {
  const f = fixture(), seen = [];
  const first = f.queue.request(() => seen.push("cancelled"));
  const old = f.requested[0];
  f.queue.cancel(first);
  f.queue.request(() => seen.push("new"));
  const next = f.requested[1];
  assert.deepEqual(f.cancelled, [old]);
  f.emit(old);
  assert.deepEqual(seen, []);
  f.emit(next);
  assert.deepEqual(seen, ["new"]);
});

test("an earlier callback can cancel a later callback in the same native pulse", () => {
  const f = fixture(), seen = [];
  let later;
  f.queue.request(() => { seen.push("a"); f.queue.cancel(later); });
  later = f.queue.request(() => seen.push("cancelled"));
  f.emit(f.requested[0]);
  assert.deepEqual(seen, ["a"]);
});

test("callback errors preserve the rest of the batch and leave scheduling live", () => {
  const f = fixture(), seen = [];
  f.queue.request(() => { throw new Error("broken"); });
  f.queue.request(() => { seen.push("b"); f.queue.request(() => seen.push("next")); });
  f.emit(f.requested[0]);
  f.emit(f.requested[1]);
  assert.deepEqual(seen, ["b", "next"]);
  assert.equal(f.errors.length, 1);
});

test("a failed native pulse falls back without letting a late native event steal the callback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), seen = [];
  f.queue.request(() => seen.push("frame"));
  f.emit(f.requested[0], true);
  f.emit(f.requested[0]);
  assert.deepEqual(seen, []);
  t.mock.timers.tick(0);
  assert.deepEqual(seen, ["frame"]);
  assert.equal(f.queue.usesNativeClock(), false);
});
