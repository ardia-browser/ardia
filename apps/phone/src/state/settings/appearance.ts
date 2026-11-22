import { useMemo } from "react";
import { Appearance, useColorScheme } from "react-native";
import { create } from "zustand";
import { appearanceSummary, appliedDark, chromeStyle, macLookOf, preferredScheme, type ChromeStyle, type PreferredScheme } from "../../lib/appearance";
import type { Design } from "../../lib/design";
import { activeCustomLook, themedScheme, type CustomLook } from "../../lib/profileLook";
import { overrideColorScheme } from "../../platform/look";
import { useReduceTransparency } from "../app/systemLook";
import { syncData, useSync } from "../sync/store";
import { shownProfile } from "../sync/syncRules";
import { currentPreferences, usePreferences } from "./store";
import { currentCustomTheme, useCustomTheme, useThemeDraft } from "./themeDraft";
import { syncOffered } from "../../platform/system";

export const useAppearanceDesign = create<{ design: Design }>()(() => ({ design: "original" }));

export const useMacLook = () => useSync((s) => macLookOf(s.status.isEnabled, s.view.look));

function useActiveCustomLook(): CustomLook | null {
  const choice = usePreferences((p) => p.colorChoice);
  const theme = useCustomTheme();
  const enabled = useSync((s) => s.status.isEnabled);
  const profile = useSync((s) => shownProfile(s.view, s.status));
  return useMemo(() => activeCustomLook(choice, theme, enabled, profile), [choice, theme, enabled, profile]);
}

function currentActiveCustomLook(): CustomLook | null {
  const { status, view } = syncData();
  return activeCustomLook(currentPreferences().colorChoice, currentCustomTheme(), status.isEnabled, shownProfile(view, status));
}

const schemeFor = (design: Design, preferred: PreferredScheme, custom: CustomLook | null): PreferredScheme => (design === "material" ? preferred : themedScheme(custom, preferred));

export function usePreferredScheme(): PreferredScheme {
  const design = useAppearanceDesign((s) => s.design);
  const choice = usePreferences((p) => p.schemeChoice);
  const custom = useActiveCustomLook();
  return schemeFor(design, preferredScheme(design, choice, useMacLook()), custom);
}

function currentPreferredScheme(): PreferredScheme {
  const { status, view } = syncData();
  const design = useAppearanceDesign.getState().design;
  return schemeFor(design, preferredScheme(design, currentPreferences().schemeChoice, macLookOf(status.isEnabled, view.look)), currentActiveCustomLook());
}

export function currentDarkScheme(): boolean {
  return appliedDark(currentPreferredScheme(), Appearance.getColorScheme() === "dark");
}

export function useDarkScheme(): boolean {
  const system = useColorScheme() === "dark";
  return appliedDark(usePreferredScheme(), system);
}

export function useChromeStyle(): ChromeStyle {
  const design = useAppearanceDesign((s) => s.design);
  const choice = usePreferences((p) => p.interfaceStyle);
  const reduceTransparency = useReduceTransparency();
  return chromeStyle(design, choice, useMacLook(), reduceTransparency);
}

export function useAppearanceSummary(colorName: (choice: string) => string): string {
  const color = usePreferences((p) => p.colorChoice);
  const style = usePreferences((p) => p.interfaceStyle);
  const scheme = usePreferences((p) => p.schemeChoice);
  return appearanceSummary(color === null ? null : colorName(color), style, scheme, syncOffered());
}

let overridden: PreferredScheme = null;
let following = false;

function applyColorScheme() {
  const next = currentPreferredScheme();
  if (next === overridden) return;
  overridden = next;
  overrideColorScheme(next);
}

export function setAppearanceDesign(design: Design) {
  useAppearanceDesign.setState({ design });
  if (!following) {
    following = true;
    usePreferences.subscribe(applyColorScheme);
    useSync.subscribe(applyColorScheme);
    useThemeDraft.subscribe(applyColorScheme);
  }
  applyColorScheme();
}
