import { useBrowser } from "../browser/store";
import type { ProfileColor, ProfileTheme } from "../browser/types";
import { adoptProfileTheme } from "../sync/engine";
import { withOwnLook, withPresetChosen } from "../../lib/presetLook";
import { noteThemePreset } from "../telemetry/themePresetCounts";

export { holdThemedWindowsKeyLook } from "../../platform/theme";

export function setProfileTheme(profileId: string, theme: ProfileTheme | null, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().profiles[profileId];
  if (!profile) return;
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, withOwnLook(profile, theme));
}

export const showingTheme = (profileId: string): ProfileTheme | null | undefined => useBrowser.getState().profiles[profileId]?.theme;

export const showingPreset = (profileId: string): ProfileColor => useBrowser.getState().profiles[profileId]?.color ?? "plum";

export function choosePresetColor(profileId: string, color: ProfileColor, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().profiles[profileId];
  const choice = profile ? withPresetChosen(profile, color) : null;
  if (!choice) return;
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, choice);
}

export function resetPresetTheme(profileId: string, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().profiles[profileId];
  if (!profile?.theme) return;
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, withOwnLook(profile, null));
  noteThemePreset("reset");
}

export function onPresetSelection(profileId: string, changed: () => void): () => void {
  return useBrowser.subscribeTo(["profiles"], (state, before) => {
    if (state.profiles[profileId]?.color !== before.profiles[profileId]?.color) changed();
  });
}
