import { parseColor } from "../../browser/src/lib/color";
import { adjustingLightness, displayP3, type Vec4 } from "./shims/web/gl/colors";

import type { BackdropThemeSource } from "./backdropTheme";

export type BehindWindowGlass = { available: () => boolean; watch: (element: HTMLElement, theme?: BackdropThemeSource | null) => () => void };

export const wantsBehindWindowGlass = (vibrancy: boolean | undefined, available: boolean): boolean => !!vibrancy && available;

export function behindWindowGlassSwitch(glass: Pick<BehindWindowGlass, "watch">) {
  let watched: HTMLElement | null = null;
  let stop: (() => void) | null = null;
  return (element: HTMLElement | null, on: boolean) => {
    const next = on ? element : null;
    if (next === watched) return;
    stop?.();
    stop = null;
    watched = next;
    if (next) stop = glass.watch(next);
  };
}

export const WINDOW_TREATMENT = {
  tintColor: "#808080",
  tintAlpha: 0.36,
  tintLightness: 0.25,
  dark: { base: "rgba(0, 0, 0, 0.4)", gradientOpacity: 0.5 },
  light: { base: "rgba(255, 255, 255, 0.8)", gradientOpacity: 0.75 },
} as const;

export type GlassTreatment = { base: string; gradient: string; gradientOpacity: number };

export function glassTreatment(dark: boolean, tintColor: string | undefined, tintAlpha: number = WINDOW_TREATMENT.tintAlpha, tintLightness: number = WINDOW_TREATMENT.tintLightness): GlassTreatment {
  const look = dark ? WINDOW_TREATMENT.dark : WINDOW_TREATMENT.light;
  const [r, g, b] = parseColor(tintColor || WINDOW_TREATMENT.tintColor);
  const color: Vec4 = [r / 255, g / 255, b / 255, 1];
  const alpha = Math.min(1, Math.max(0, tintAlpha));
  const top = displayP3(color, alpha);
  const bottom = displayP3(adjustingLightness(color, tintLightness), alpha);
  return { base: look.base, gradient: `linear-gradient(to bottom in display-p3, ${top}, ${bottom})`, gradientOpacity: look.gradientOpacity };
}
