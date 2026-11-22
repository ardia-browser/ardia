import { create } from "zustand";
import type { ProfileTheme } from "@ardia/core/src/theme.ts";
import { currentPreferences, usePreferences } from "./store";

export const useThemeDraft = create<{ draft: ProfileTheme | null }>()(() => ({ draft: null }));

export function useCustomTheme(): ProfileTheme | null {
  const draft = useThemeDraft((s) => s.draft);
  const stored = usePreferences((p) => p.customTheme);
  return draft ?? stored;
}

export const currentCustomTheme = (): ProfileTheme | null => useThemeDraft.getState().draft ?? currentPreferences().customTheme;
