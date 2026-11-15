import assert from "node:assert/strict";
import { test } from "node:test";
import { cutOutKeyframes, cutOutSpread, holeRectAt, pagesToCut, slotFill, UNPAINTED_SLOT, type LocalRect } from "./pageSlotRules";

test("a hidden tab's slot paints nothing, a shown one paints the unpainted fill for the app's appearance", () => {
  assert.equal(slotFill(false, false), null);
  assert.equal(slotFill(false, true), null);
  assert.deepEqual(slotFill(true, false), { backgroundColor: UNPAINTED_SLOT.light });
  assert.deepEqual(slotFill(true, true), { backgroundColor: UNPAINTED_SLOT.dark });
  assert.deepEqual(slotFill(undefined, false), { backgroundColor: UNPAINTED_SLOT.light });
});

test("a shown page gets its hole only once it has painted, so its slot stays opaque until then", () => {
  const shown = new Map([
    ["early", { x: 0 }],
    ["late", { x: 1 }],
  ]);
  const painted = new Set<string>();
  assert.deepEqual([...pagesToCut(shown, painted).keys()], []);
  painted.add("early");
  assert.deepEqual([...pagesToCut(shown, painted).keys()], ["early"]);
  painted.add("late");
  painted.add("hidden");
  assert.deepEqual([...pagesToCut(shown, painted).keys()], ["early", "late"]);
});

const samples = { durationMs: 250, rects: [[0, 0, 100, 50], [10, 5, 80, 40], [40, 20, 20, 10]], offsets: [0, 100 / 250, 1] };

const near = (actual: number[] | undefined, expected: number[]) => {
  if (!actual) return assert.fail("no rect");
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - (expected[index] ?? NaN)) < 1e-9, `${actual} vs ${expected}`));
};

test("the hole follows the motion samples, interpolating between them by their offsets", () => {
  near(holeRectAt(samples, -5), [0, 0, 100, 50]);
  near(holeRectAt(samples, 0), [0, 0, 100, 50]);
  near(holeRectAt(samples, 50), [5, 2.5, 90, 45]);
  near(holeRectAt(samples, 100), [10, 5, 80, 40]);
  near(holeRectAt(samples, 175), [25, 12.5, 50, 25]);
  near(holeRectAt(samples, 250), [40, 20, 20, 10]);
  near(holeRectAt(samples, 400), [40, 20, 20, 10]);
  near(holeRectAt({ ...samples, rects: [[1, 2, 3, 4]], offsets: [1] }, 10), [1, 2, 3, 4]);
});

const applied = (transform: string, base: LocalRect): LocalRect => {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+), (-?[\d.]+)\)/.exec(transform);
  if (!match) return assert.fail(transform);
  const [tx, ty, sx, sy] = match.slice(1).map(Number) as [number, number, number, number];
  return { x: base.x + tx, y: base.y + ty, width: base.width * sx, height: base.height * sy };
};

test("the cut-out's keyframes carry its resting box onto each sample, with the samples' offsets", () => {
  const local = samples.rects.map(([x = 0, y = 0, width = 0, height = 0]) => ({ x, y, width, height }));
  const keyframes = cutOutKeyframes(local, samples.offsets);
  const base = local[local.length - 1]!;
  assert.deepEqual(keyframes.map((frame) => frame.offset), samples.offsets);
  keyframes.forEach((frame, index) => {
    const moved = applied(String(frame.transform), base);
    const want = local[index]!;
    for (const side of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(moved[side] - want[side]) < 0.01, `${index} ${side}: ${moved[side]} vs ${want[side]}`);
  });
  assert.equal(keyframes.at(-1)?.transform, "translate(0px, 0px) scale(1, 1)");
  assert.deepEqual(cutOutKeyframes([{ x: 0, y: 0, width: 0, height: 10 }], [1]), []);
});

test("the cut-out's spread still covers the whole underlay at the motion's smallest scale", () => {
  const local = samples.rects.map(([x = 0, y = 0, width = 0, height = 0]) => ({ x, y, width, height }));
  const spread = cutOutSpread(local, 1200, 800);
  const smallest = Math.min(...local.map((rect) => Math.min(rect.width / 20, rect.height / 10)));
  assert.ok(spread * smallest >= 1200 * 2, `${spread} at ${smallest}`);
  assert.equal(cutOutSpread([{ x: 0, y: 0, width: 0, height: 0 }], 10, 10), 0);
});
