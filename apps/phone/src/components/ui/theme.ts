import { createContext, useContext, useMemo } from "react";
import { useDarkScheme } from "../../state/settings/appearance";
import { backdropStops, presetLook, showsTheme, windowTintStops, type PresetSpec, type ProfileLook } from "../../lib/profileLook";
import { withAlpha } from "../../lib/color";
import { colorRoles, PROFILE_COLORS, tabsInk, type ColorRoles, type ProfileColor } from "./tokens";
import { useDesign } from "./design";
import { rolesFromScheme } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";
import { spaceAccentFor, type SpaceAccent } from "./accentRoles";

export { spaceAccentFor, type SpaceAccent } from "./accentRoles";

export type StartBackdrop = { colors: string[]; diagonal: boolean };

export type Theme = ColorRoles & SpaceAccent & { backdrop: [string, string]; canvas: string; start: StartBackdrop };

export const rolesFor = (dark: boolean): ColorRoles => (dark ? colorRoles.dark : colorRoles.light);

export const PROFILE_PRESETS: PresetSpec[] = (Object.keys(PROFILE_COLORS) as ProfileColor[]).map((key) => ({
  key,
  swatch: PROFILE_COLORS[key].swatch,
  tint: PROFILE_COLORS[key].tint,
}));

export const DEFAULT_PROFILE_COLOR: ProfileColor = "plum";

const presetLookFor = (key: ProfileColor) => presetLook(PROFILE_PRESETS.find((preset) => preset.key === key)!);

const DEFAULT_LOOK = presetLookFor(DEFAULT_PROFILE_COLOR);

export const PRIVATE_ACCENT: SpaceAccent = spaceAccentFor(presetLookFor("neutral"), true);

const privateAccentRoles = { ...PRIVATE_ACCENT, accent: PRIVATE_ACCENT.spaceAccent, formAccent: PRIVATE_ACCENT.spaceAccentInk };

export const incognitoTheme = (base: Theme): Theme => ({ ...base, ...rolesFor(true), ...privateAccentRoles });

export const ProfileLookContext = createContext<ProfileLook>(DEFAULT_LOOK);

export const useProfileLook = () => useContext(ProfileLookContext);

const IncognitoLookContext = createContext(false);

export const IncognitoLook = IncognitoLookContext.Provider;

export const useIncognitoLook = () => useContext(IncognitoLookContext);

const ForcedDarkContext = createContext<boolean | null>(null);

export const ForcedDark = ForcedDarkContext.Provider;

export function useTheme(): Theme {
  const look = useProfileLook();
  const schemeDark = useDarkScheme();
  const incognitoLook = useIncognitoLook();
  const forcedDark = useContext(ForcedDarkContext);
  const material = useDesign() === "material";
  const { scheme } = useMaterialTheme();
  return useMemo(() => {
    const dark = forcedDark ?? (schemeDark || (incognitoLook && !material));
    if (material) {
      const canvas = scheme.surface;
      return { ...rolesFromScheme(scheme, dark), spaceAccent: scheme.primary, spaceAccentInk: scheme.primary, spaceAccentGlyph: scheme.primary, onSpaceAccent: scheme.onPrimary, spaceAccentWash: withAlpha(scheme.primary, 0.12), backdrop: [canvas, canvas], canvas, start: { colors: [canvas, scheme.surfaceContainerLow], diagonal: false } };
    }
    const backdrop: [string, string] = incognitoLook ? [...tabsInk.incognitoBackdrop] : windowTintStops(look, dark);
    const start = { colors: backdropStops(look, dark, true), diagonal: showsTheme(look, dark, true) };
    const space = incognitoLook ? PRIVATE_ACCENT : spaceAccentFor(look, dark);
    return { ...rolesFor(dark), ...space, accent: space.spaceAccent, formAccent: space.spaceAccentInk, backdrop, canvas: backdrop[0], start };
  }, [look, schemeDark, incognitoLook, forcedDark, material, scheme]);
}
