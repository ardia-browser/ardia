import { create } from "zustand";
import type { ProfileTheme } from "@ardia/core/src/theme.ts";
import { ownThemeOf, type ProfileLook } from "../../lib/profileLook";
import { PRESET_COLORS, type ColorChoice, type PresetColor, type Preferences } from "./preferences";
import { currentPreferences, usePreferences } from "./store";
import { syncData } from "../sync/store";
import { materialPresetFor } from "../../lib/material/schemePick";

export const useThemeDraft = create<{ draft: ProfileTheme | null }>()(() => ({ draft: null }));

export const chosenOwnTheme = (preferences: Pick<Preferences, "colorChoice" | "customTheme" | "presetThemes" | "materialYou">): ProfileTheme | null => ownThemeOf(preferences);

export function useCustomTheme(): ProfileTheme | null {
  const draft = useThemeDraft((s) => s.draft);
  const stored = usePreferences(chosenOwnTheme);
  return draft ?? stored;
}

export const currentCustomTheme = (): ProfileTheme | null => useThemeDraft.getState().draft ?? chosenOwnTheme(currentPreferences());

export const isPresetColor = (key: string | null): key is PresetColor => PRESET_COLORS.includes(key as PresetColor);

export const themeLockedNow = () => currentPreferences().colorChoice === null && syncData().status.isEnabled;

export function selectedSwatch({ colorChoice, presetThemes }: Pick<Preferences, "colorChoice" | "presetThemes">, look: ProfileLook, material = false): ColorChoice | null {
  if (material) return materialPresetFor(colorChoice);
  if (colorChoice !== null) return colorChoice;
  if (look.custom || !isPresetColor(look.preset)) return null;
  return presetThemes[look.preset] ? null : look.preset;
}
