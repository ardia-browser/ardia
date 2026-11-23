import { isHexColor, isLight, luminance, mix, parseColor } from "../../lib/color";
import { HIGHLIGHT_PUSH } from "./tokens";

export type VaultHighlight = { fill: string; onLight: boolean; surface: string };

const MIN_SEPARATION = 1.6;
const STEP = 0.1;
const MIN_BRAND_CHROMA = 0.25;
const ACCENT_WHITE_INK = 3;

export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

function apartFrom(fill: string, surface: string): string {
  const toward = isLight(surface) ? HIGHLIGHT_PUSH.darker : HIGHLIGHT_PUSH.lighter;
  let shown = fill;
  for (let t = STEP; contrast(shown, surface) < MIN_SEPARATION && t <= 1; t += STEP) shown = mix(fill, toward, t);
  return shown;
}

const chroma = (color: string) => {
  const [r, g, b] = parseColor(color);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
};

export const isBrandColor = (color: string, surface: string) => chroma(color) >= MIN_BRAND_CHROMA && contrast(color, surface) >= MIN_SEPARATION;

function brandOf(color: string | null, surface: string): string | null {
  const hex = color && isHexColor(color) ? color.slice(0, 7) : null;
  return hex && isBrandColor(hex, surface) ? hex : null;
}

const READABLE = 4.5;
const MOST_DEEPENING = 0.35;

export function readableBrand(brand: string): { fill: string; onLight: boolean } {
  for (let t = 0; t <= MOST_DEEPENING + 1e-9; t += STEP / 2) {
    const fill = t === 0 ? brand : mix(brand, HIGHLIGHT_PUSH.darker, t);
    if (contrast(HIGHLIGHT_PUSH.lighter, fill) >= READABLE) return { fill, onLight: false };
  }
  return { fill: brand, onLight: true };
}

export function vaultHighlight(websiteColor: string | null, extendWebsiteColor: boolean, accent: string, surface: string): VaultHighlight {
  const brand = brandOf(extendWebsiteColor ? websiteColor : null, surface);
  if (brand) {
    const shown = readableBrand(brand);
    if (contrast(shown.fill, surface) >= MIN_SEPARATION && contrast(shown.onLight ? HIGHLIGHT_PUSH.darker : HIGHLIGHT_PUSH.lighter, shown.fill) >= READABLE) return { ...shown, surface };
  }
  const fill = apartFrom(isHexColor(accent) ? accent.slice(0, 7) : accent, surface);
  return { fill, onLight: contrast(HIGHLIGHT_PUSH.lighter, fill) < ACCENT_WHITE_INK && isLight(fill), surface };
}

const RETRY_GLYPH_CONTRAST = 3;

type VaultRetryInk = { glyph: string; disc: string | null };

export function touchRetryInk(fill: string | null, destructive: string): VaultRetryInk {
  if (!fill || contrast(destructive, fill) >= RETRY_GLYPH_CONTRAST) return { glyph: destructive, disc: null };
  return { glyph: HIGHLIGHT_PUSH.lighter, disc: destructive };
}
