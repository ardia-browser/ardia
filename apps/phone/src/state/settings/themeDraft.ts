import { create } from "zustand";
import type { ProfileTheme } from "@ardia/core/src/theme.ts";
import type { Preferences } from "./preferences";
import { currentPreferences, usePreferences } from "./store";

export const useThemeDraft = create<{ draft: ProfileTheme | null }>()(() => ({ draft: null }));

export function chosenOwnTheme({ colorChoice, customTheme, presetThemes, materialYou }: Pick<Preferences, "colorChoice" | "customTheme" | "presetThemes" | "materialYou">): ProfileTheme | null {
  if (colorChoice === null) return null;
  if (colorChoice === "custom") return customTheme;
  return materialYou ? null : (presetThemes[colorChoice] ?? null);
}

export function useCustomTheme(): ProfileTheme | null {
  const draft = useThemeDraft((s) => s.draft);
  const stored = usePreferences(chosenOwnTheme);
  return draft ?? stored;
}

export const currentCustomTheme = (): ProfileTheme | null => useThemeDraft.getState().draft ?? chosenOwnTheme(currentPreferences());
