import { over, parseColor, toHex } from "./color";
import { oklab } from "./profileLook";

export const MIN_SELECTION_LIGHTNESS = 0.06;

const ALPHA_STEP = 0.01;
const MAX_FALLBACK_ALPHA = 0.5;
const MAX_LINE_ALPHA = 0.3;

function lightness(color: string): number {
  const [r, g, b] = parseColor(color);
  return oklab({ r: r / 255, g: g / 255, b: b / 255, a: 1 })[0];
}

export function selectionLightnessDelta(fill: string, backdrops: readonly string[]): number {
  return Math.min(...backdrops.map((backdrop) => Math.abs(lightness(over(fill, backdrop)) - lightness(backdrop))));
}

const overlayAt = (color: string, alpha: number) => {
  const [r, g, b] = parseColor(color);
  return toHex([r, g, b, Math.round(alpha * 100) * 2.55]);
};

function lifted(fill: string, fallback: string, backdrops: readonly string[], cap: number): string {
  const passes = (color: string) => selectionLightnessDelta(color, backdrops) >= MIN_SELECTION_LIGHTNESS;
  if (!backdrops.length || passes(fill)) return fill;
  for (let alpha = ALPHA_STEP; alpha <= cap + 1e-9; alpha += ALPHA_STEP) {
    const shown = overlayAt(fallback, alpha);
    if (passes(shown)) return shown;
  }
  return overlayAt(fallback, cap);
}

export const visibleSelection = (fill: string, fallback: string, backdrops: readonly string[]): string => lifted(fill, fallback, backdrops, MAX_FALLBACK_ALPHA);

export const visibleLine = (line: string, ink: string, backdrops: readonly string[]): string => lifted(line, ink, backdrops, MAX_LINE_ALPHA);
