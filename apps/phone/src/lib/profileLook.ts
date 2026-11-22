import {
  lookAngle,
  opaqueThemeTint,
  resolveTheme,
  sanitizeTheme,
  shownLook,
  themeAccent,
  themePalette,
  type ProfileTheme,
  type ThemeLook,
  type ThemeLookSource,
  type ThemeMode,
} from "@ardia/core/src/theme.ts";
import { hslToRgb, rgbToHsl, withAlpha } from "./color.ts";

type Rgb = readonly [number, number, number];

export type PresetSpec = { key: string; swatch: string; tint?: string };

export type CustomLook = { theme: ProfileTheme; source: ThemeLookSource };

export type ProfileLook = {
  preset: string | null;
  swatch: string;
  tint: string;
  isNeutral: boolean;
  theme: readonly string[];
  darkTheme: readonly string[] | null;
  custom: CustomLook | null;
};

export type SyncedThemeLook = Omit<ThemeLook, "angle"> & { angle: number };

export type SyncedTheme = { colors: string[]; darkColors: string[] | null; mode?: ThemeMode; look?: SyncedThemeLook | null; dark?: SyncedThemeLook | null };

export type LookSource = { color: string | null; theme: SyncedTheme | null };

export type NativeThemeLook = SyncedThemeLook;

export const CUSTOM_CHOICE = "custom";

const WINDOW_ALPHA = 0.36;
const NEUTRAL_ALPHA = 0.12;
const WINDOW_LIGHTNESS = 0.25;
const HUE_SATURATION = 0.36;
const HUE_LIGHTNESS = 0.527;
const LIGHT_SHARE = 0.75;
const DARK_SHARE = 0.5;
const NEUTRAL_SATURATION = 0.12;
const NEUTRAL_KEY = "neutral";
const INACTIVE_LIGHT: Rgb = [235 / 255, 231 / 255, 230 / 255];
const INACTIVE_DARK: Rgb = [40.7 / 255, 33.1 / 255, 31.8 / 255];
const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const byte = (value: number) => Math.floor(clamp(value) * 255 + 0.5);

function parse(text: string | null | undefined): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text?.trim() ?? "");
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const parsed = (text: string) => parse(text) ?? BLACK;
const hex = (rgb: Rgb) => `#${rgb.map((v) => byte(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const snapped = (rgb: Rgb): Rgb => parsed(hex(rgb));
const mixed = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
];
const hsl = (rgb: Rgb) => rgbToHsl(rgb[0], rgb[1], rgb[2]);
const isNeutralKey = (key: string) => key === NEUTRAL_KEY;

function lightened(rgb: Rgb, delta: number): Rgb {
  const [h, s, l] = hsl(rgb);
  return hslToRgb(h, s, clamp(l + delta));
}

const tintForHue = (swatch: Rgb, grey: boolean): Rgb => snapped(hslToRgb(hsl(swatch)[0], grey ? 0 : HUE_SATURATION, HUE_LIGHTNESS));

export function presetLook(preset: PresetSpec): ProfileLook {
  const neutral = isNeutralKey(preset.key);
  const swatch = parsed(preset.swatch);
  const tint = parse(preset.tint) ?? tintForHue(swatch, neutral);
  return { preset: preset.key, swatch: hex(swatch), tint: hex(tint), isNeutral: neutral, theme: [], darkTheme: null, custom: null };
}

export function customLook(theme: ProfileTheme, source: ThemeLookSource): ProfileLook {
  const accent = parsed(themeAccent(theme));
  const isNeutral = hsl(accent)[1] < NEUTRAL_SATURATION;
  return {
    preset: null,
    swatch: hex(accent),
    tint: hex(tintForHue(accent, isNeutral)),
    isNeutral,
    theme: themePalette(theme),
    darkTheme: theme.dark ? themePalette(theme.dark) : null,
    custom: { theme, source },
  };
}

export function syncedTheme(theme: SyncedTheme | null | undefined): ProfileTheme | null {
  if (!theme?.look) return null;
  return sanitizeTheme({ ...theme.look, mode: theme.mode ?? "auto", dark: theme.dark ?? undefined });
}

function colorsOf(list: readonly string[] | null | undefined): Rgb[] {
  return (list ?? []).map(parse).filter((color): color is Rgb => color !== null);
}

export function lookOf(source: LookSource, presets: readonly PresetSpec[], fallback: string): ProfileLook {
  const full = syncedTheme(source.theme);
  if (full) return customLook(full, "app");
  const named = (key: string | null | undefined) => presets.find((preset) => preset.key === key?.trim().toLowerCase());
  const theme = colorsOf(source.theme?.colors);
  const darkTheme = colorsOf(source.theme?.darkColors);
  const first = theme[0] ?? parse(source.color);
  if (!first) return presetLook(named(source.color) ?? named(fallback) ?? presets[0]!);
  const middle = theme.slice(1).reduce((mix, next) => mixed(mix, next, 0.5), first);
  const isNeutral = hsl(middle)[1] < NEUTRAL_SATURATION;
  const look: ProfileLook = {
    preset: null,
    swatch: hex(middle),
    tint: hex(tintForHue(middle, isNeutral)),
    isNeutral,
    theme: theme.map(hex),
    darkTheme: darkTheme.length ? darkTheme.map(hex) : null,
    custom: null,
  };
  if (look.theme.length || look.darkTheme) return look;
  const same = presets.map(presetLook).find((preset) => preset.swatch === look.swatch && preset.tint === look.tint && preset.isNeutral === look.isNeutral);
  return same ?? look;
}

export function lookForApp(
  choice: string | null,
  syncEnabled: boolean,
  profile: LookSource | null,
  presets: readonly PresetSpec[],
  fallback: string,
  customTheme: ProfileTheme | null = null,
): ProfileLook {
  if (choice === CUSTOM_CHOICE && customTheme) return customLook(customTheme, "own");
  const chosen = presets.find((preset) => preset.key === choice);
  if (chosen) return presetLook(chosen);
  return lookOf(syncEnabled && profile && choice === null ? profile : { color: null, theme: null }, presets, fallback);
}

export function activeCustomLook(choice: string | null, customTheme: ProfileTheme | null, syncEnabled: boolean, profile: LookSource | null): CustomLook | null {
  if (choice === CUSTOM_CHOICE) return customTheme ? { theme: customTheme, source: "own" } : null;
  if (choice !== null || !syncEnabled) return null;
  const synced = syncedTheme(profile?.theme);
  return synced ? { theme: synced, source: "app" } : null;
}

export function themedScheme(custom: CustomLook | null, preferred: "light" | "dark" | null): "light" | "dark" | null {
  if (!custom) return preferred;
  const shownDark = (appDark: boolean) => shownLook(custom.theme, appDark, custom.source).dark;
  if (preferred) return shownDark(preferred === "dark") ? "dark" : "light";
  const light = shownDark(false);
  return light === shownDark(true) ? (light ? "dark" : "light") : null;
}

export function shownTheme(custom: CustomLook, dark: boolean): ProfileTheme {
  for (const appDark of [dark, !dark]) {
    const shown = shownLook(custom.theme, appDark, custom.source);
    if (shown.dark === dark) return shown.look;
  }
  return resolveTheme(custom.theme, dark);
}

const resolvedLooks = new WeakMap<CustomLook, [NativeThemeLook | undefined, NativeThemeLook | undefined]>();

export function themeLookFor(look: ProfileLook, dark: boolean): NativeThemeLook | null {
  if (!look.custom) return null;
  const known = resolvedLooks.get(look.custom) ?? [undefined, undefined];
  const cached = known[dark ? 1 : 0];
  if (cached) return cached;
  const theme = shownTheme(look.custom, dark);
  const { stops, intensity, grain, texture, translucency } = theme;
  const resolved = { stops: stops.map((stop) => ({ color: { ...stop.color }, x: stop.x, y: stop.y })), intensity, grain, texture, translucency, angle: lookAngle(theme) };
  known[dark ? 1 : 0] = resolved;
  resolvedLooks.set(look.custom, known);
  return resolved;
}

export const choiceAfterMatchToggle = (matches: boolean, look: ProfileLook, fallback: string): string | null =>
  matches ? null : look.custom ? CUSTOM_CHOICE : (look.preset ?? fallback);

export const themeStops = (look: ProfileLook, dark: boolean): readonly string[] => (dark ? (look.darkTheme ?? look.theme) : look.theme);

export const showsTheme = (look: ProfileLook, dark: boolean, themed: boolean) => themed && (look.custom !== null || themeStops(look, dark).length >= 2);

export function windowTintStops(look: ProfileLook, dark: boolean): [string, string] {
  const alpha = (look.isNeutral ? NEUTRAL_ALPHA : WINDOW_ALPHA) * (dark ? DARK_SHARE : LIGHT_SHARE);
  const under = dark ? mixed(INACTIVE_DARK, BLACK, 0.4) : mixed(WHITE, INACTIVE_LIGHT, 0.2);
  const tint = parsed(look.tint);
  return [hex(mixed(under, tint, alpha)), hex(mixed(under, lightened(tint, WINDOW_LIGHTNESS), alpha))];
}

export function backdropStops(look: ProfileLook, dark: boolean, themed: boolean): string[] {
  const resolved = themed ? themeLookFor(look, dark) : null;
  if (resolved) return opaqueThemeTint(resolved, dark);
  return showsTheme(look, dark, themed) ? [...themeStops(look, dark)] : windowTintStops(look, dark);
}

export function spaceTone(source: LookSource | null, dark: boolean, increasedContrast: boolean, presets: readonly PresetSpec[], fallback: string): string[] {
  const toward = dark ? BLACK : WHITE;
  const amount = dark ? (increasedContrast ? 0.8 : 0.66) : increasedContrast ? 0.9 : 0.8;
  const theme = source?.theme;
  if (theme) {
    const colors = colorsOf(dark ? (theme.darkColors ?? theme.colors) : theme.colors);
    if (colors.length) {
      const themeAmount = dark && theme.darkColors ? (increasedContrast ? 0.5 : 0.25) : amount;
      return colors.map((color) => hex(mixed(color, toward, themeAmount)));
    }
  }
  const base = parsed(lookOf({ color: source?.color ?? null, theme: null }, presets, fallback).swatch);
  return [hex(mixed(base, toward, amount)), hex(mixed(base, toward, amount + (dark ? 0.06 : -0.04)))];
}

export type NativeLookColors = { color: string; themeColors: string[]; darkThemeColors: string[] | null; themeLook: NativeThemeLook | null };

const GLASS_TINT_SHARE = 0.15;

export const lookGlassTint = (look: ProfileLook): string | undefined => (look.isNeutral ? undefined : withAlpha(look.tint, GLASS_TINT_SHARE));

export function nativeLookColors(look: ProfileLook, dark: boolean): NativeLookColors {
  return { color: look.preset ?? look.swatch, themeColors: [...look.theme], darkThemeColors: look.darkTheme ? [...look.darkTheme] : null, themeLook: themeLookFor(look, dark) };
}
