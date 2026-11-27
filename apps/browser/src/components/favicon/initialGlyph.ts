import { capFittedFontSize } from "../glyph/capFit";

const INITIAL = { scale: 0.64, nudgeX: 0.25, nudgedUpToPixelsPerPoint: 2.5 } as const;

export type InitialGlyph = { fontSize: number; lineShiftX: number; onPixelGrid: boolean };

const wholePixels = (pixels: number) => Math.abs(pixels - Math.round(pixels)) < 1e-6;

export function initialGlyph(tile: number, pixelsPerPoint: number, snapsBaselines: boolean): InitialGlyph {
  const fontSize = Math.round(tile * INITIAL.scale);
  if (!snapsBaselines || !wholePixels(tile * pixelsPerPoint)) return { fontSize, lineShiftX: 0, onPixelGrid: false };
  const lineShiftX = pixelsPerPoint <= INITIAL.nudgedUpToPixelsPerPoint ? Math.floor(2 * INITIAL.nudgeX * pixelsPerPoint) / (2 * pixelsPerPoint) : 0;
  if (!wholePixels(pixelsPerPoint)) return { fontSize, lineShiftX, onPixelGrid: false };
  return { fontSize: capFittedFontSize(fontSize, tile, pixelsPerPoint), lineShiftX, onPixelGrid: true };
}
