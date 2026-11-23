import assert from "node:assert/strict";
import { test } from "node:test";
const { guardedLive } = await import("./Closing.tsx");
const { tapActivates } = await import("./a11y.ts");

test("a callback the host still holds from the open render does nothing once closing has committed", () => {
  const latest = { current: false };
  const live = guardedLive(latest, new WeakMap());
  const calls = [];
  const press = (n) => calls.push(n);
  const held = live(press);
  held(1);
  latest.current = true;
  held(2);
  latest.current = false;
  held(3);
  assert.deepEqual(calls, [1, 3]);
});

test("the guard keeps one wrapper per handler, so a stable handler stays a stable prop", () => {
  const live = guardedLive({ current: false }, new WeakMap());
  const press = () => {};
  assert.equal(live(press), live(press));
  assert.notEqual(live(press), live(() => {}));
  assert.equal(live(undefined), undefined);
  assert.equal(live("value"), "value");
});

test("the native accessibility press runs the same action as a press, and there is none without one", () => {
  const events = [];
  tapActivates((e) => events.push(e))();
  assert.deepEqual(events, [{ nativeEvent: {} }]);
  assert.equal(tapActivates(undefined), undefined);
  assert.equal(tapActivates(null), undefined);
});
