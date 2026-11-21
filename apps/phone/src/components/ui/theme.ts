import { createContext, useContext, useMemo } from "react";
import { useDarkScheme } from "../../state/settings/appearance";
import { backdropStops, lookAccents, presetLook, showsTheme, windowTintStops, type PresetSpec, type ProfileLook } from "../../lib/profileLook";
import { withAlpha } from "../../lib/color";
import { colorRoles, PROFILE_COLORS, type ColorRoles, type ProfileColor } from "./tokens";
import { useDesign } from "./design";
import { rolesFromScheme } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";

export type StartBackdrop = { colors: string[]; diagonal: boolean };

export type SpaceAccent = { spaceAccent: string; spaceAccentInk: string; onSpaceAccent: string; spaceAccentWash: string };

export type Theme = ColorRoles & SpaceAccent & { backdrop: [string, string]; surface: string; start: StartBackdrop };

export const rolesFor = (dark: boolean): ColorRoles => (dark ? colorRoles.dark : colorRoles.light);

const NEUTRAL_ACCENT = { light: { fill: "#1C1C1E", ink: "#1C1C1E", on: "#FFFFFF" }, dark: { fill: "#F2F2F7", ink: "#F2F2F7", on: "#000000" } } as const;

export function spaceAccentFor(look: ProfileLook, dark: boolean): SpaceAccent {
  if (look.isNeutral) {
    const neutral = dark ? NEUTRAL_ACCENT.dark : NEUTRAL_ACCENT.light;
    return { spaceAccent: neutral.fill, spaceAccentInk: neutral.ink, onSpaceAccent: neutral.on, spaceAccentWash: withAlpha(neutral.fill, 0.08) };
  }
  const ink = dark ? look.swatch : look.tint;
  return { spaceAccent: look.tint, spaceAccentInk: ink, onSpaceAccent: "#FFFFFF", spaceAccentWash: withAlpha(look.tint, dark ? 0.22 : 0.12) };
}

export const PROFILE_PRESETS: PresetSpec[] = (Object.keys(PROFILE_COLORS) as ProfileColor[]).map((key) => ({
  key,
  swatch: PROFILE_COLORS[key].swatch,
  tint: PROFILE_COLORS[key].tint,
}));

export const DEFAULT_PROFILE_COLOR: ProfileColor = "plum";

const DEFAULT_LOOK = presetLook(PROFILE_PRESETS.find((preset) => preset.key === DEFAULT_PROFILE_COLOR)!);

export const ProfileLookContext = createContext<ProfileLook>(DEFAULT_LOOK);

export const useProfileLook = () => useContext(ProfileLookContext);

export function useTheme(): Theme {
  const look = useProfileLook();
  const dark = useDarkScheme();
  const material = useDesign() === "material";
  const { scheme } = useMaterialTheme();
  return useMemo(() => {
    if (material) {
      const surface = scheme.surface;
      return { ...rolesFromScheme(scheme, dark), spaceAccent: scheme.primary, spaceAccentInk: scheme.primary, onSpaceAccent: scheme.onPrimary, spaceAccentWash: withAlpha(scheme.primary, 0.12), backdrop: [surface, surface], surface, start: { colors: [surface, scheme.surfaceContainerLow], diagonal: false } };
    }
    const backdrop = windowTintStops(look, dark);
    const start = { colors: backdropStops(look, dark, true), diagonal: showsTheme(look, dark, true) };
    const accents = lookAccents(look, dark);
    const tinted = accents ? { accent: accents.accent, formAccent: accents.formAccent } : null;
    return { ...rolesFor(dark), ...spaceAccentFor(look, dark), ...tinted, backdrop, surface: backdrop[0], start };
  }, [look, dark, material, scheme]);
}
