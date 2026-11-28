import assert from "node:assert/strict";
import { test } from "node:test";
const { barPlacement } = await import("./SelectionPopover.tsx");
const { useInterfaceScale, devicePixelsPerRootPoint } = await import("../../state/settings/interfaceScale.ts");
const { INTERFACE_SCALE } = await import("../../lib/interfaceScale.ts");

const AREA = { width: 1200, height: 800 };
const CONTENT_WIDTH = 118.37;

const yogaWidth = (left, width, pixelsPerPoint) => {
  const grid = (v) => Math.round(v * pixelsPerPoint) / pixelsPerPoint;
  return Math.fround(grid(Math.fround(left) + width) - grid(Math.fround(left)));
};

function layoutsUntilSettled(rect) {
  const pixelsPerPoint = devicePixelsPerRootPoint();
  let width = 0;
  for (let pass = 1; pass <= 20; pass++) {
    const next = yogaWidth(barPlacement(rect, 1, AREA, width).x, CONTENT_WIDTH, pixelsPerPoint);
    if (next === width) return pass;
    width = next;
  }
  return Infinity;
}

const selectionsAround = (center) =>
  Array.from({ length: 200 }, (_, i) => ({ x: center + i / 100 - 40, y: 300, width: 80, height: 18 }));

const steps = Math.round((INTERFACE_SCALE.max - INTERFACE_SCALE.min) / INTERFACE_SCALE.step);
const scales = Array.from({ length: steps + 1 }, (_, i) => Math.round((INTERFACE_SCALE.min + i * INTERFACE_SCALE.step) * 100) / 100);

for (const scale of scales) {
  test(`the search bar settles on one width wherever the selection sits, at interface scale ${scale}`, () => {
    useInterfaceScale.setState({ scale });
    try {
      const restless = selectionsAround(300).filter((rect) => layoutsUntilSettled(rect) > 3);
      assert.deepEqual(restless.map((r) => r.x), []);
    } finally {
      useInterfaceScale.setState({ scale: 1 });
    }
  });
}

test("the search bar stays centred over the selection and inside the page", () => {
  const width = 118.5;
  const centred = barPlacement({ x: 260, y: 300, width: 80, height: 18 }, 1, AREA, width);
  assert.ok(Math.abs(centred.x + width / 2 - 300) <= 0.5);
  assert.equal(barPlacement({ x: 0, y: 300, width: 10, height: 18 }, 1, AREA, width).x, 8);
  assert.equal(barPlacement({ x: 1190, y: 300, width: 10, height: 18 }, 1, AREA, width).x, AREA.width - width - 8);
});

test("the search bar sits above the selection when there's room, and hides when the selection scrolls away", () => {
  assert.equal(barPlacement({ x: 260, y: 300, width: 80, height: 18 }, 1, AREA, 100).above, true);
  assert.equal(barPlacement({ x: 260, y: 2, width: 80, height: 18 }, 1, AREA, 100).above, false);
  assert.equal(barPlacement({ x: 260, y: -40, width: 80, height: 18 }, 1, AREA, 100), null);
});
