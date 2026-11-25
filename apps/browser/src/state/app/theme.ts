import { useContext } from "react";
import { spaceLookSource, type LookSource } from "../../lib/profileLook";
import { PageProfileContext, useSettings, WindowContext } from "../browser/hooks";
import { useBrowser } from "../browser/store";
import type { Profile } from "../browser/types";
import { focusedWindowOf } from "../windows/ui";
import { useBasePaletteValue } from "../config/hooks";
import type { BasePalette } from "../../lib/themeFile";

export function useScopedLook<T>(resolve: (incognito: boolean, profile: Profile | undefined, appDark: boolean, source: LookSource, palette: BasePalette | null) => T): T {
  const windowId = useContext(WindowContext);
  const page = useContext(PageProfileContext);
  const palette = useBasePaletteValue();
  return useBrowser((s) => {
    const w = s.windows[windowId ?? focusedWindowOf(s) ?? ""];
    if (w?.kind === "private") return resolve(true, undefined, s.ui.appDark, "own", palette);
    return resolve(false, s.profiles[page ?? w?.profileId ?? s.settings.defaultProfileId], s.ui.appDark, windowId ? spaceLookSource(s.settings) : "utility", palette);
  });
}

export function useGlassSettings() {
  const glass = useSettings((s) => s.interfaceStyle === "glass");
  const tint = useSettings((s) => (s.glassTintWithTheme ? s.glassTintAmount : 0));
  return { glass, tint };
}

export function useSelectedTabGlowSetting() {
  return useBrowser((s) => s.settings.selectedTabGlow);
}

export function useSelectedTopApp() {
  return useSettings((s) => (s.elementOutlines ? s.selectedTopApp : "fill"));
}
