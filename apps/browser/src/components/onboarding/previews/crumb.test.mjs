import assert from "node:assert/strict";
import { test } from "node:test";
const { crumbSwap } = await import("./timeline.ts");

const valueAt = (stops, ms) => {
  if (ms <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    const [from, a] = stops[k - 1];
    const [to, b] = stops[k];
    if (ms <= to) return a + ((b - a) * (ms - from)) / (to - from);
  }
  return stops[stops.length - 1][1];
};

test("swapping the address crumb never shows the old and the new page on top of each other, there or back", () => {
  const { first, second } = crumbSwap(520, 1700);
  for (let ms = 0; ms <= 2600; ms += 1) {
    const a = valueAt(first.opacity, ms);
    const b = valueAt(second.opacity, ms);
    assert.ok(a <= 0.01 || b <= 0.01, `at ${ms} ms the first crumb is at ${a.toFixed(2)} and the second at ${b.toFixed(2)}`);
  }
  assert.equal(valueAt(first.opacity, 519), 1);
  assert.equal(valueAt(second.opacity, 519), 0);
  assert.equal(valueAt(first.opacity, 1200), 0);
  assert.equal(valueAt(second.opacity, 1200), 1);
});

test("the crumb loop ends where it starts, so a looping scene has no seam", () => {
  const { first, second } = crumbSwap(520, 1700);
  for (const stops of [first.opacity, first.x, second.opacity, second.x]) assert.equal(valueAt(stops, 0), valueAt(stops, 2600));
});

test("the crumb slides the way the tab rows do: the leaving one goes left, the arriving one comes in from the right", () => {
  const { first, second } = crumbSwap(520, 1700);
  assert.ok(valueAt(first.x, 640) < 0);
  assert.ok(valueAt(second.x, 640) > 0);
  assert.equal(valueAt(second.x, 1200), 0);
  assert.ok(valueAt(second.x, 1820) < 0);
  assert.ok(valueAt(first.x, 1820) > 0);
});
