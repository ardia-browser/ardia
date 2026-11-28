import assert from "node:assert/strict";
import { test } from "node:test";
const { INTERFACE_SCALE_STEPS } = await import("../../lib/interfaceScale.ts");
const { selectedTabShape } = await import("./selectedTabShape.ts");
const { FLARE, MAX_CHIP, SELECTED_BODY_INSET, SELECTED_STEPS, TITLED_CHIP } = await import("./tokens.ts");

const near = (a, b) => Math.abs(a - b) < 1e-4;

function yogaRounded(value, pixelsPerPoint) {
  const scaled = value * pixelsPerPoint;
  let fraction = scaled % 1;
  if (fraction < 0) fraction += 1;
  if (near(fraction, 0)) return Math.round(scaled - fraction);
  if (near(fraction, 1)) return Math.round(scaled - fraction + 1);
  return Math.round(scaled - fraction + (fraction > 0.5 || near(fraction, 0.5) ? 1 : 0));
}

function yogaPixels(parentLeft, left, width, pixelsPerPoint) {
  const from = yogaRounded(left, pixelsPerPoint);
  return { from, to: from + yogaRounded(parentLeft + left + width, pixelsPerPoint) - yogaRounded(parentLeft + left, pixelsPerPoint) };
}

function seams(chipLeft, shape, pixelsPerPoint) {
  const body = yogaPixels(chipLeft, shape.inset, shape.body, pixelsPerPoint);
  const leftFlare = yogaPixels(chipLeft, shape.inset - shape.flare, shape.flare, pixelsPerPoint);
  const rightFlare = yogaPixels(chipLeft, shape.inset + shape.body, shape.flare, pixelsPerPoint);
  return { left: body.from - leftFlare.to, right: rightFlare.from - body.to };
}

const BACKING_SCALES = [1, 2, 3];
const CHIP_WIDTHS = [...SELECTED_STEPS, TITLED_CHIP, MAX_CHIP - 0.5, 141.37, 96.25, 133.3333];
const CHIP_LEFTS = Array.from({ length: 500 }, (_, i) => 80 + i * 0.0959);
const grids = BACKING_SCALES.flatMap((backing) => INTERFACE_SCALE_STEPS.map((scale) => ({ backing, scale, pixelsPerPoint: backing * scale })));

function broken(shapeOf) {
  const found = [];
  for (const grid of grids) {
    let gaps = 0;
    let overlaps = 0;
    for (const width of CHIP_WIDTHS) {
      const shape = shapeOf(width, grid.pixelsPerPoint);
      for (const chipLeft of CHIP_LEFTS) {
        const seam = seams(chipLeft, shape, grid.pixelsPerPoint);
        gaps += (seam.left > 0) + (seam.right > 0);
        overlaps += (seam.left < 0) + (seam.right < 0);
      }
    }
    if (gaps || overlaps) found.push({ ...grid, gaps, overlaps });
  }
  return found;
}

test("the selected tab's body meets both flares on the same device pixel at every interface size and display density, wherever the chip sits", () => {
  assert.equal(grids.length, BACKING_SCALES.length * 15);
  assert.deepEqual(broken(selectedTabShape), []);
});

test("a chip width that animates snaps its body by the same rule, with add, modulo and subtract", () => {
  const animated = (width, pixelsPerPoint) => {
    const shape = selectedTabShape(width, pixelsPerPoint);
    const pixel = 1 / pixelsPerPoint;
    const halfUp = width - 2 * shape.inset + pixel / 2;
    const modulo = ((halfUp % pixel) + pixel) % pixel;
    return { ...shape, body: halfUp - modulo };
  };
  assert.deepEqual(broken(animated), []);
});

test("unsnapped lengths leave a one pixel gap beside the body at 115% on a 1x display, the reported case", () => {
  const unsnapped = (width) => ({ inset: SELECTED_BODY_INSET, flare: FLARE, body: width - 2 * SELECTED_BODY_INSET });
  const reported = broken(unsnapped).find((grid) => grid.backing === 1 && grid.scale === 1.15);
  assert.ok(reported.gaps > 0);
});

test("at 100% the shape keeps its designed lengths on a 2x display and stays within a device pixel of them elsewhere", () => {
  assert.deepEqual(selectedTabShape(MAX_CHIP, 2), { inset: SELECTED_BODY_INSET, flare: FLARE, body: MAX_CHIP - 2 * SELECTED_BODY_INSET });
  for (const { pixelsPerPoint } of grids) {
    const shape = selectedTabShape(MAX_CHIP, pixelsPerPoint);
    const pixel = 1 / pixelsPerPoint;
    assert.ok(Math.abs(shape.inset - SELECTED_BODY_INSET) <= pixel / 2 + 1e-9);
    assert.ok(Math.abs(shape.flare - FLARE) <= pixel / 2 + 1e-9);
    assert.ok(Math.abs(shape.inset * 2 + shape.body - MAX_CHIP) <= pixel + 1e-9);
  }
});
