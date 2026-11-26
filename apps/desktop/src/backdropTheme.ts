import { backdropUnderColor, type ThemeTexture } from "@ardia/core";
import { parseColor } from "../../browser/src/lib/color";
import { adjustingLightness, type Vec4 } from "./shims/web/gl/colors";
import { baseLine, baseStops, filmGrainOpacity, filmGrainSize, GRAIN_POINTS, overlayLine, overlayStops, swatchColors, type SwatchLine, type SwatchStop } from "./shims/web/gl/themeSwatch";
import { WINDOW_TREATMENT } from "./behindWindowGlass";

export const WINDOW_BACKDROP_CAPABILITY = "shell.windowBackdrop";
export const DEFAULT_SWATCH_ANGLE = 135;

export type ThemeColor = [number, number, number, number, 0 | 1];
export type BackdropThemeLayer =
  | { kind: "fill"; color: ThemeColor; opacity: number }
  | { kind: "gradient"; start: [number, number]; end: [number, number]; stops: { offset: number; color: ThemeColor }[]; opacity: number }
  | { kind: "grain"; texture: string; opacity: number; points: number };
export type BackdropTheme = { layers: BackdropThemeLayer[]; opacity: number };
export type BackdropThemeSource = (size: { width: number; height: number }) => BackdropTheme | null;

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, +value.toFixed(5))) : 0);
const srgb = ([r, g, b, a]: Vec4): ThemeColor => [unit(r), unit(g), unit(b), unit(a), 0];
const p3 = ([r, g, b]: Vec4, alpha: number): ThemeColor => [unit(r), unit(g), unit(b), unit(alpha), 1];
const css = (color: string): ThemeColor => {
  const [r, g, b, a] = parseColor(color);
  return [unit(r / 255), unit(g / 255), unit(b / 255), unit(a), 0];
};
const point = (x: number, y: number): [number, number] => [+x.toFixed(5), +y.toFixed(5)];
const gradient = (line: SwatchLine, stops: SwatchStop[], opacity: number): BackdropThemeLayer => ({
  kind: "gradient",
  start: point(line.x1, line.y1),
  end: point(line.x2, line.y2),
  stops: stops.map(({ offset, color }) => ({ offset: unit(offset), color: srgb(color) })),
  opacity: unit(opacity),
});

export type ThemedBackdropSpec = { colors: number[]; opacity: number; underlayAlpha: number; grain?: number; texture?: ThemeTexture; angle?: number; dark: boolean };

export function themedBackdropTheme({ colors, opacity, underlayAlpha, grain = 0, texture, angle, dark }: ThemedBackdropSpec, size: { width: number; height: number }): BackdropTheme {
  const parsed = swatchColors(colors);
  const base = baseStops(parsed);
  const overlay = overlayStops(parsed);
  const shown = angle ?? DEFAULT_SWATCH_ANGLE;
  const layers: BackdropThemeLayer[] = [{ kind: "fill", color: css(backdropUnderColor(underlayAlpha, dark)), opacity: 1 }];
  if (base.length) layers.push(gradient(baseLine(size.width, size.height, shown), base, opacity));
  if (base.length && overlay.length) layers.push(gradient(overlayLine(size.width, size.height, shown), overlay, opacity));
  const grained = unit(grain);
  if (grained > 0) layers.push({ kind: "grain", texture: texture ?? "grain", opacity: grained, points: GRAIN_POINTS });
  return { layers, opacity: 1 };
}

export type TreatmentBackdropSpec = { dark: boolean; tintColor?: string; tintAlpha?: number; tintLightness?: number; grainOpacity?: number; grainScale?: number };

export function treatmentBackdropTheme({ dark, tintColor, tintAlpha = WINDOW_TREATMENT.tintAlpha, tintLightness = WINDOW_TREATMENT.tintLightness, grainOpacity, grainScale }: TreatmentBackdropSpec): BackdropTheme {
  const look = dark ? WINDOW_TREATMENT.dark : WINDOW_TREATMENT.light;
  const [r, g, b] = parseColor(tintColor || WINDOW_TREATMENT.tintColor);
  const color: Vec4 = [r / 255, g / 255, b / 255, 1];
  const alpha = Math.min(1, Math.max(0, tintAlpha));
  const layers: BackdropThemeLayer[] = [
    { kind: "fill", color: css(look.base), opacity: 1 },
    { kind: "gradient", start: [0.5, 0], end: [0.5, 1], stops: [{ offset: 0, color: p3(color, alpha) }, { offset: 1, color: p3(adjustingLightness(color, tintLightness), alpha) }], opacity: look.gradientOpacity },
  ];
  const grained = filmGrainOpacity(grainOpacity);
  if (grained > 0) layers.push({ kind: "grain", texture: "film", opacity: grained, points: filmGrainSize(grainScale) });
  return { layers, opacity: 1 };
}
