import { hslToRgb, parseColor, rgbToHsl, toHex } from "../../lib/color";
import { themeStops, type ProfileLook } from "../../lib/profileLook";

type Tone = { hueShift: number; saturation: number; lightness: number };

const TONES: Record<"light" | "dark", readonly [Tone, Tone, Tone]> = {
  light: [
    { hueShift: -0.05, saturation: 0.3, lightness: 0.7 },
    { hueShift: 0, saturation: 0.28, lightness: 0.6 },
    { hueShift: 0.05, saturation: 0.32, lightness: 0.5 },
  ],
  dark: [
    { hueShift: -0.06, saturation: 0.34, lightness: 0.15 },
    { hueShift: 0, saturation: 0.3, lightness: 0.1 },
    { hueShift: 0.05, saturation: 0.42, lightness: 0.19 },
  ],
};

const NEUTRAL_SATURATION = 0.05;
const NEUTRAL_THEME = 0.12;

export const startIncognitoStops = ["#232327", "#141416", "#202024"] as const;

export const startButtonFill = { light: "rgba(255,255,255,0.32)", dark: "rgba(255,255,255,0.12)" } as const;

export const startLogo = { width: 150, iconSide: 128, dragFollow: 0.72, dragTilt: 10, dragLift: 1.05, slop: 6, settle: { response: 0.55, damping: 0.5 }, press: { response: 0.18, damping: 1 }, reducedSettleMs: 200 } as const;

const hueOf = (hex: string) => {
  const [r, g, b] = parseColor(hex);
  return rgbToHsl(r / 255, g / 255, b / 255);
};

const toned = (hue: number, tone: Tone, neutral: boolean) => {
  const turned = (((hue + tone.hueShift) % 1) + 1) % 1;
  return toHex(hslToRgb(turned, neutral ? NEUTRAL_SATURATION : tone.saturation, tone.lightness).map((channel) => channel * 255));
};

export function startGradient(look: ProfileLook, dark: boolean, incognito: boolean): string[] {
  if (incognito) return [...startIncognitoStops];
  const tones = TONES[dark ? "dark" : "light"];
  const theme = themeStops(look, dark);
  if (theme.length >= 2) {
    const picks = [theme[0]!, look.swatch, theme[theme.length - 1]!].map(hueOf);
    return picks.map(([hue, saturation], at) => toned(hue, { ...tones[at]!, hueShift: 0 }, saturation < NEUTRAL_THEME));
  }
  const hue = hueOf(look.swatch)[0];
  return tones.map((tone) => toned(hue, tone, look.isNeutral));
}
