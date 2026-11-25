import { DEFAULT_THEME_ANGLE, flatColors, lookAngle, themeGrainAlpha, themeLayerAlpha, themeUnderlayAlpha, type ProfileTheme, type ThemeBackdropProps, type ThemeColor, type ThemeLookSource } from "@ardia/core/src/theme.ts";
import { parseColor } from "./color";

export {
  arcLayerAlpha,
  colorHex,
  DARKENED_LOOK_KEEP,
  darkenedLook,
  DEFAULT_THEME_ANGLE,
  flatColors,
  fromOklab,
  lookAngle,
  MAX_THEME_STOPS,
  mixOklab,
  oklab,
  opaqueThemeTint,
  PAD_LIGHTNESS,
  padColor,
  padPosition,
  readableDark,
  requestedDarkFor,
  resolveTheme,
  sanitizeTheme,
  shownLook,
  startingTheme,
  stopLightness,
  themeAccent,
  themeArea,
  themeDark,
  themeGrainAlpha,
  themeLayerAlpha,
  themeLuminance,
  themePalette,
  themeUnderColor,
  themeUnderlayAlpha,
  withAddedStop,
  withAngle,
  withoutStop,
  withStopAt,
  withStopLightness,
  type ProfileTheme,
  type ShownLook,
  type ThemeColor,
  type ThemeLook,
  type ThemeStop,
} from "@ardia/core";

export type LookSource = ThemeLookSource;

export const PROFILE_COLOR_NAMES = ["plum", "blue", "purple", "pink", "red", "orange", "yellow", "green", "neutral"] as const;

export type ProfileColor = (typeof PROFILE_COLOR_NAMES)[number];

export type PresetThemes = Partial<Record<ProfileColor, ProfileTheme>>;

export type ProfileLookFields = { color: ProfileColor; theme?: ProfileTheme | null };

export type PresetLookFields = ProfileLookFields & { presetThemes?: PresetThemes };

export const PRESET_BACKDROP: ThemeBackdropProps = {
  themeColors: [],
  themeOpacity: 1,
  themeBaseAlpha: 0,
  themeGrain: 0,
  themeTexture: "grain",
  themeAppearance: "auto",
  themeAngle: DEFAULT_THEME_ANGLE,
};

export function hexColor(hex: string): ThemeColor {
  const [r, g, b] = parseColor(hex);
  return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
}

export function spaceLookSource(settings: { spacesFollowAppearance: boolean }): LookSource {
  return settings.spacesFollowAppearance ? "app" : "own";
}

export function themeBackdrop(theme: ProfileTheme, dark: boolean): ThemeBackdropProps {
  return {
    themeColors: flatColors(theme),
    themeOpacity: themeLayerAlpha(theme),
    themeBaseAlpha: themeUnderlayAlpha(theme, dark),
    themeGrain: themeGrainAlpha(theme),
    themeTexture: theme.texture,
    themeAppearance: theme.mode,
    themeAngle: lookAngle(theme),
  };
}
