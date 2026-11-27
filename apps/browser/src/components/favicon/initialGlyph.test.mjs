import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { initialGlyph } = await import("./initialGlyph.ts");
const { inkCentered, inkCenteredOnGrid } = await import("../glyph/CapCenteredLetter.tsx");
const { SYSTEM_FONT } = await import("../glyph/capFit.ts");
const { appliedInterfaceScale, devicePixelsPerRootPoint } = await import("../../state/settings/interfaceScale.ts");

const capPixels = (fontSize, pixelsPerPoint) => fontSize * SYSTEM_FONT.capHeight * pixelsPerPoint;

function assertCentredOnPixels(tile, pixelsPerPoint) {
  const { fontSize } = initialGlyph(tile, pixelsPerPoint, true);
  const cap = capPixels(fontSize, pixelsPerPoint);
  assert.ok(Math.abs(cap - Math.round(cap)) < 1e-9, `cap ${cap} px is not whole at ${pixelsPerPoint}x for a ${tile} pt tile`);
  assert.equal((Math.round(tile * pixelsPerPoint) - Math.round(cap)) % 2, 0, `cap ${cap} px can't centre in a ${tile} pt tile at ${pixelsPerPoint}x`);
  const base = capPixels(Math.round(tile * 0.64), pixelsPerPoint);
  assert.ok(Math.abs(cap - base) <= 1 + 1e-9, `cap ${cap} px strays more than a pixel from ${base} px`);
}

test("the initial's cap height is whole device pixels with the tile's parity on a Retina display", () => {
  for (const tile of [12, 14, 16, 18]) assertCentredOnPixels(tile, 2);
  assert.ok(Math.abs(initialGlyph(14, 2, true).fontSize - 12 / (SYSTEM_FONT.capHeight * 2)) < 1e-9);
});

test("on a 1x display the cap height fits the 1x pixel grid, not the Retina one", () => {
  for (const tile of [12, 14, 16, 18]) assertCentredOnPixels(tile, 1);
  const compact = initialGlyph(12, 1, true);
  assert.equal((12 - Math.round(capPixels(compact.fontSize, 1))) % 2, 0);
});

test("the line moves right a quarter point, in half device pixels the subpixel-positioned text can land on", () => {
  for (const [pixelsPerPoint, pixels] of [[1, 0], [2, 0.5], [2.5, 0.5], [3, 0]]) {
    const { lineShiftX } = initialGlyph(14, pixelsPerPoint, true);
    assert.equal(lineShiftX * pixelsPerPoint, pixels, `${pixelsPerPoint}x moves the glyph ${lineShiftX * pixelsPerPoint} px`);
    assert.ok(lineShiftX <= 0.25);
    assert.equal(Number.isInteger(2 * lineShiftX * pixelsPerPoint), true, "the padding that centres it is whole device pixels");
  }
});

test("a tile that doesn't span whole device pixels keeps main's size, place and no nudge", () => {
  for (const pixelsPerPoint of [1.7, 1.8, 2.1, 2.3, 2.4, 2.6]) assert.deepEqual(initialGlyph(14, pixelsPerPoint, true), { fontSize: 9, lineShiftX: 0, onPixelGrid: false });
});

test("at a fractional density a whole-pixel tile keeps main's size and place, with the nudge", () => {
  assert.deepEqual(initialGlyph(14, 2.5, true), { fontSize: 9, lineShiftX: 0.2, onPixelGrid: false });
});

test("an Interface Size change refits the initial to the new device pixels per point", () => {
  appliedInterfaceScale(1);
  const before = initialGlyph(12, devicePixelsPerRootPoint(), true);
  appliedInterfaceScale(1.5);
  assert.equal(devicePixelsPerRootPoint(), 3);
  const after = initialGlyph(12, devicePixelsPerRootPoint(), true);
  assert.equal(before.onPixelGrid && after.onPixelGrid, true);
  assert.notEqual(after.fontSize, before.fontSize);
  assertCentredOnPixels(12, 3);
  appliedInterfaceScale(1);
});

test("Linux and Windows keep the rounded font size and no nudge", () => {
  assert.deepEqual(initialGlyph(12, 2, false), { fontSize: 8, lineShiftX: 0, onPixelGrid: false });
  assert.deepEqual(initialGlyph(14, 2, false), { fontSize: 9, lineShiftX: 0, onPixelGrid: false });
  assert.deepEqual(initialGlyph(18, 1, false), { fontSize: 12, lineShiftX: 0, onPixelGrid: false });
});

test("on the pixel grid the letter is placed by one translation from the tile's top, rounded once", () => {
  const metrics = { ascender: 8.23, capHeight: 6 };
  for (const pixelsPerPoint of [1, 2, 3]) {
    for (const box of [12, 14, 18]) {
      const holder = inkCenteredOnGrid(box, 0, metrics.capHeight / 2, metrics, pixelsPerPoint);
      const exact = box / 2 - Math.round(metrics.ascender) + metrics.capHeight / 2;
      assert.equal(holder.top, 0);
      assert.equal(holder.left, 0);
      assert.ok(Math.abs(holder.transform[1].translateY * pixelsPerPoint - Math.round(exact * pixelsPerPoint)) < 1e-9);
    }
  }
});

test("profile badges keep main's holder and translation on 1x and 2x displays", () => {
  appliedInterfaceScale(1);
  const metrics = { ascender: 11, capHeight: 5 };
  const badge = inkCentered(20, 0, 3.5, metrics, 0);
  assert.equal(badge.top, 2);
  assert.deepEqual(badge.transform, [{ translateX: 0 }, { translateY: 0.5 }]);
  const edged = inkCentered(20, -0.19, 3.5, metrics, 0.5);
  assert.equal(edged.top, 1.5);
  assert.equal(edged.left, -0.5);
  assert.equal(edged.transform[0].translateX + 0, 0);
  assert.equal(edged.transform[1].translateY, 0.5);
});
