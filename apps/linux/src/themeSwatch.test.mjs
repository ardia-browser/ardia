import assert from "node:assert/strict";
import test from "node:test";
import { baseLine, baseStops, GRAIN_SIDE, grainAlpha, overlayLine, overlayStops, padLayers, srgbFromOklab, stopCss, swatchColors, SWATCH_SAMPLES } from "./shims/web/gl/themeSwatch.ts";
import { oklab } from "./shims/web/gl/colors.ts";

const near = (actual, expected, slack = 1e-4) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} is not ${expected}`);

test("a swatch reads at most three RGBA colours from the flat list", () => {
  assert.deepEqual(swatchColors([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 9, 9, 9, 9]), [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 0.5]]);
  assert.deepEqual(swatchColors([1, 0, 0]), []);
});

test("the base gradient is sampled in Oklab between the first two colours, as the Mac layer does", () => {
  const a = [0.79, 0.31, 0.95, 1];
  const b = [0.39, 0.48, 0.95, 1];
  const stops = baseStops([a, b, [0.1, 0.88, 0.81, 1]]);
  assert.equal(stops.length, SWATCH_SAMPLES + 1);
  for (const i of [0, 1, 2]) near(stops[0].color[i], a[i], 2e-3);
  for (const i of [0, 1, 2]) near(stops.at(-1).color[i], b[i], 2e-3);
  const [la, lb] = [oklab(a), oklab(b)];
  const middle = srgbFromOklab([(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2, (la[2] + lb[2]) / 2, 1]);
  assert.deepEqual(stops[SWATCH_SAMPLES / 2].color.map((v) => +v.toFixed(4)), middle.map((v) => +v.toFixed(4)));
  assert.equal(baseStops([a]).length, 2);
  assert.deepEqual(baseStops([]), []);
});

test("the third colour fades in over the base, and only when there is one", () => {
  assert.deepEqual(overlayStops([[1, 0, 0, 1], [0, 1, 0, 1]]), []);
  assert.deepEqual(overlayStops([[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 0.8]]), [{ offset: 0, color: [0, 0, 1, 0] }, { offset: 1, color: [0, 0, 1, 0.8] }]);
});

test("gradient lines match the Mac layer's start and end points", () => {
  const square = baseLine(28, 28, 180);
  near(square.x1, 0.5); near(square.y1, 0.5 - Math.SQRT1_2); near(square.x2, 0.5); near(square.y2, 0.5 - Math.SQRT1_2 + 1.5 * Math.SQRT1_2);
  const right = baseLine(28, 28, 90);
  near(right.x1, 0.5 - Math.SQRT1_2); near(right.y1, 0.5); near(right.x2, 0.5 + 0.5 * Math.SQRT1_2); near(right.y2, 0.5);
  const over = overlayLine(100, 50, 45);
  near(over.x1, 0); near(over.y1, 0.5); near(over.x2, 1); near(over.y2, 0.5);
  const tiny = baseLine(0, 0, 135);
  assert.ok(Object.values(tiny).every(Number.isFinite));
});

test("stops clamp to what CSS can show", () => {
  assert.deepEqual(stopCss([1.2, -0.1, 0.5, 2]), { color: "rgb(255, 0, 128)", opacity: 1 });
});

test("every texture makes a tile of black at the Mac's darkening range", () => {
  const ranges = { grain: [0, 0.211], sand: [0.132, 1], denim: [0.068, 0.068 + 0.226], tweed: [0.261, 0.261 + 0.23] };
  for (const [texture, [floor, ceiling]] of Object.entries(ranges)) {
    const bytes = grainAlpha(texture);
    assert.equal(bytes.length, GRAIN_SIDE * GRAIN_SIDE * 4, texture);
    let low = 255, high = 0, colour = 0;
    for (let i = 0; i < bytes.length; i += 4) { colour += bytes[i] + bytes[i + 1] + bytes[i + 2]; low = Math.min(low, bytes[i + 3]); high = Math.max(high, bytes[i + 3]); }
    assert.equal(colour, 0, texture);
    assert.ok(low >= Math.floor(floor * 255) && high <= Math.ceil(ceiling * 255) && high > low, `${texture} ${low}..${high}`);
  }
  assert.deepEqual(grainAlpha("unknown"), grainAlpha("grain"));
  assert.deepEqual(grainAlpha("sand"), grainAlpha("sand"));
});

test("the colour pad is a hue wheel that greys toward its centre at the given lightness", () => {
  const { wheel, centre } = padLayers(0.5);
  assert.match(wheel, /^conic-gradient\(from 90deg, hsl\(0 100% 50%\) 0deg, .*hsl\(360 100% 50%\) 360deg\)$/);
  assert.equal(centre, "radial-gradient(closest-side, rgba(128, 128, 128, 1), rgba(128, 128, 128, 0))");
});
