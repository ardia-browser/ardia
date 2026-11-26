export type SectionRange = { lo: number; hi: number };
export type SectionFrame = { y: number; h: number };

export const clampTo = (value: number, r: SectionRange) => Math.min(r.hi, Math.max(r.lo, value));

export function sectionFrames(
  keys: readonly string[],
  heights: Readonly<Record<string, number>>,
  viewport: number,
  gap: number,
): Record<string, SectionFrame> {
  const out: Record<string, SectionFrame> = {};
  if (viewport <= 0) return out;
  let y = viewport / 2;
  for (const key of keys) {
    const h = heights[key];
    if (h === undefined) break;
    out[key] = { y, h };
    y += h + gap;
  }
  return out;
}

export function rangeOf(frame: SectionFrame | undefined, viewport: number, edge: number): SectionRange | null {
  if (!frame || viewport <= 0) return null;
  if (frame.h + edge * 2 <= viewport) {
    const centre = frame.y + frame.h / 2 - viewport / 2;
    return { lo: centre, hi: centre };
  }
  return { lo: frame.y - edge, hi: frame.y + frame.h + edge - viewport };
}
