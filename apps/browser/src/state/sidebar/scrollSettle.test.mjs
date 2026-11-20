import assert from "node:assert/strict";
import { test } from "node:test";
const hover = await import("./hover.ts");

const W = "settle-window";

function scrolling(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const armed = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    armed.push(ms);
    return original(fn, ms, ...rest);
  };
  t.after(() => (globalThis.setTimeout = original));
  return armed;
}

const flick = (t, events, gap = 16) => {
  for (let i = 0; i < events; i++) {
    hover.noteRowsScrolled(W);
    t.mock.timers.tick(gap);
  }
};

test("a scroll with no row under the pointer arms no timer, however long it runs", (t) => {
  const armed = scrolling(t);
  flick(t, 120);
  t.mock.timers.tick(1000);
  assert.deepEqual(armed, []);
});

test("a row passing under a still pointer gets its enter once the list has been still for 150 ms", (t) => {
  scrolling(t);
  const row = {};
  let entered = 0;
  flick(t, 3);
  assert.equal(
    hover.holdEnterWhileScrolling(W, row, () => entered++),
    true,
  );
  flick(t, 20);
  assert.equal(entered, 0);
  t.mock.timers.tick(149 - 16);
  assert.equal(entered, 0);
  t.mock.timers.tick(1);
  assert.equal(entered, 1);
  t.mock.timers.tick(1000);
  assert.equal(entered, 1);
});

test("once the list is still, an enter goes straight through instead of being held", (t) => {
  const armed = scrolling(t);
  flick(t, 5);
  t.mock.timers.tick(150);
  assert.equal(
    hover.holdEnterWhileScrolling(W, {}, () => {}),
    false,
  );
  assert.deepEqual(armed, []);
});

test("a dropped held enter never fires", (t) => {
  scrolling(t);
  const row = {};
  let entered = 0;
  flick(t, 2);
  hover.holdEnterWhileScrolling(W, row, () => entered++);
  assert.equal(hover.dropHeldEnter(W, row), true);
  t.mock.timers.tick(1000);
  assert.equal(entered, 0);
});
