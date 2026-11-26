export const SYSTEM_FONT = { ascender: 0.9668, capHeight: 0.7046 } as const;

export function capFittedFontSize(fontSize: number, box: number, pixelsPerPoint: number): number {
  const boxPixels = Math.round(box * pixelsPerPoint);
  const capPixels = fontSize * SYSTEM_FONT.capHeight * pixelsPerPoint;
  const below = Math.floor(capPixels);
  const sameParity = (below - boxPixels) % 2 === 0 ? below : below - 1;
  const fitted = capPixels - sameParity <= 1 ? sameParity : sameParity + 2;
  return fitted > 0 ? fitted / (SYSTEM_FONT.capHeight * pixelsPerPoint) : fontSize;
}
