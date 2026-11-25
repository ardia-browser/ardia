import { useBrowser } from "../browser/store";
import type { ProfileColor, ProfileTheme } from "../browser/types";
import { adoptProfileTheme } from "../sync/engine";
import { withOwnLook, withPresetChosen } from "../../lib/presetLook";
import { noteThemePreset } from "../telemetry/themePresetCounts";

export { holdThemedWindowsKeyLook } from "../../platform/theme";

export function setProfileTheme(spaceId: string, theme: ProfileTheme | null, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().spaces[spaceId];
  if (!profile) return;
  adopt(spaceId);
  useBrowser.getState().updateSpace(spaceId, withOwnLook(profile, theme));
}

export const showingTheme = (spaceId: string): ProfileTheme | null | undefined => useBrowser.getState().spaces[spaceId]?.theme;

export const showingPreset = (spaceId: string): ProfileColor => useBrowser.getState().spaces[spaceId]?.color ?? "plum";

export function choosePresetColor(spaceId: string, color: ProfileColor, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().spaces[spaceId];
  const choice = profile ? withPresetChosen(profile, color) : null;
  if (!choice) return;
  adopt(spaceId);
  useBrowser.getState().updateSpace(spaceId, choice);
}

export function resetPresetTheme(spaceId: string, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().spaces[spaceId];
  if (!profile?.theme) return;
  adopt(spaceId);
  useBrowser.getState().updateSpace(spaceId, withOwnLook(profile, null));
  noteThemePreset("reset");
}

export function onPresetSelection(spaceId: string, changed: () => void): () => void {
  return useBrowser.subscribeTo(["spaces"], (state, before) => {
    if (state.spaces[spaceId]?.color !== before.spaces[spaceId]?.color) changed();
  });
}
