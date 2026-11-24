import { hslToRgb, parseColor, rgbToHsl, toHex } from "./color";

export type BackdropTint = {
  tintColor: string;
  tintAlpha: number;
  tintLightness: number;
};

const LIGHTNESS = 0.25;

export function backdropTint(color: string, neutral: boolean): BackdropTint {
  return { tintColor: color, tintAlpha: neutral ? 0.12 : 0.36, tintLightness: LIGHTNESS };
}

type Rgb = readonly [number, number, number];

export type BlurFill = { dark: Rgb; light: Rgb };

const INACTIVE_FILL: BlurFill = { dark: [40.7, 33.1, 31.8], light: [235, 231, 230] };

export const NEUTRAL_FILL: BlurFill = { dark: [68.4, 68.4, 68.4], light: [211, 211, 211] };

export function opaqueTint(tint: BackdropTint, dark: boolean, fill: BlurFill = INACTIVE_FILL): [string, string] {
  const a = tint.tintAlpha * (dark ? 0.5 : 0.75);
  const under = dark ? fill.dark.map((f) => 0.6 * f) : fill.light.map((f) => 0.8 * 255 + 0.2 * f);
  const top = parseColor(tint.tintColor).slice(0, 3);
  const bottom = lighten(top, tint.tintLightness);
  const over = (c: number[]) => toHex(c.map((v, i) => a * v + (1 - a) * under[i]!));
  return [over(top), over(bottom)];
}

export function tintForHue(swatch: string, grey = false): string {
  const [h] = hsl(parseColor(swatch));
  return toHex(fromHsl(h, grey ? 0 : 0.36, 0.527));
}

const hsl = ([r, g, b]: number[]) => rgbToHsl(r! / 255, g! / 255, b! / 255);
const fromHsl = (h: number, s: number, l: number) => hslToRgb(h, s, l).map((v) => v * 255);

function lighten(c: number[], delta: number): number[] {
  const [h, s, l] = hsl(c);
  return fromHsl(h, s, Math.min(1, Math.max(0, l + delta)));
}
