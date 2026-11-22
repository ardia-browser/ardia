import { luminance, mixColors, withAlpha } from "../../lib/color.ts";
import { windowTintStops, type ProfileLook } from "../../lib/profileLook.ts";
import { accentInkBase, accentSearchStep, accentWashAlpha, contrastMinimum, neutralAccent, neutralFills } from "./paletteTokens.ts";

export type SpaceAccent = { spaceAccent: string; spaceAccentInk: string; spaceAccentGlyph: string; onSpaceAccent: string; spaceAccentWash: string };

export function contrastBetween(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function legibleAgainst(color: string, backdrops: readonly string[], toward: string, minimum: number = contrastMinimum.text): string {
  const worst = (candidate: string) => Math.min(...backdrops.map((backdrop) => contrastBetween(candidate, backdrop)));
  let amount = 0;
  let candidate = mixColors(color, color, 0);
  while (worst(candidate) < minimum && amount < 1) {
    amount = Math.min(1, amount + accentSearchStep);
    candidate = mixColors(color, toward, amount);
  }
  return candidate;
}

export const accentBackdrops = (look: ProfileLook, dark: boolean): string[] => [...Object.values(dark ? neutralFills.dark : neutralFills.light), windowTintStops(look, dark)[0]];

export function spaceAccentFor(look: ProfileLook, dark: boolean): SpaceAccent {
  if (look.isNeutral) {
    const neutral = dark ? neutralAccent.dark : neutralAccent.light;
    return { spaceAccent: neutral.fill, spaceAccentInk: neutral.ink, spaceAccentGlyph: neutral.ink, onSpaceAccent: neutral.on, spaceAccentWash: withAlpha(neutral.fill, accentWashAlpha.neutral) };
  }
  const takesWhite = contrastBetween(accentInkBase.onFill, look.tint) >= contrastMinimum.whiteOnDeepenedFill;
  const fill = takesWhite ? legibleAgainst(look.tint, [accentInkBase.onFill], accentInkBase.darken) : look.tint;
  const onFill = takesWhite ? accentInkBase.onFill : accentInkBase.onLightFill;
  const backdrops = accentBackdrops(look, dark);
  const base = dark ? look.swatch : look.tint;
  const toward = dark ? accentInkBase.lighten : accentInkBase.darken;
  const ink = legibleAgainst(base, backdrops, toward);
  const glyph = legibleAgainst(base, backdrops, toward, contrastMinimum.glyph);
  return { spaceAccent: fill, spaceAccentInk: ink, spaceAccentGlyph: glyph, onSpaceAccent: onFill, spaceAccentWash: withAlpha(look.tint, dark ? accentWashAlpha.dark : accentWashAlpha.light) };
}
