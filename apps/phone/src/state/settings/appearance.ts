import { useColorScheme } from "react-native";
import { create } from "zustand";
import { appearanceSummary, appliedDark, chromeStyle, macLookOf, preferredScheme, type ChromeStyle, type PreferredScheme } from "../../lib/appearance";
import type { Design } from "../../lib/design";
import { overrideColorScheme } from "../../platform/look";
import { useReduceTransparency } from "../app/systemLook";
import { syncData, useSync } from "../sync/store";
import { currentPreferences, usePreferences } from "./store";
import { syncOffered } from "../../platform/system";

export const useAppearanceDesign = create<{ design: Design }>()(() => ({ design: "original" }));

export const useMacLook = () => useSync((s) => macLookOf(s.status.isEnabled, s.view.look));

export function usePreferredScheme(): PreferredScheme {
  const design = useAppearanceDesign((s) => s.design);
  const choice = usePreferences((p) => p.schemeChoice);
  return preferredScheme(design, choice, useMacLook());
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
  const { status, view } = syncData();
  const next = preferredScheme(useAppearanceDesign.getState().design, currentPreferences().schemeChoice, macLookOf(status.isEnabled, view.look));
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
  }
  applyColorScheme();
}
