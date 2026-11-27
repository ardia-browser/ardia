import { useEffect } from "react";
import { launchLookFor, launchLookSourcesLoaded, launchLookWriter, type SavedLaunchLook } from "../../lib/launchLook";
import { lookForApp, type PresetSpec, type ProfileLook } from "../../lib/profileLook";
import { rememberLaunchLook } from "../../platform/look";
import { syncOffered } from "../sync/offer";
import { savedPreferredScheme, usePreferredScheme } from "../settings/appearance";
import { currentPreferences } from "../settings/store";
import { syncData, useSync } from "../sync/store";
import { launchSpace } from "../sync/syncRules";
import { useBoot } from "./boot";

let presets: readonly PresetSpec[] = [];
let fallback = "";

function currentLaunchLook(): SavedLaunchLook | null {
  const { loaded, status, view, pickedProfileId } = syncData();
  if (!launchLookSourcesLoaded({ ready: useBoot.getState().ready, syncOffered: syncOffered(), syncLoaded: loaded })) return null;
  const { colorChoice, customTheme } = currentPreferences();
  const look = lookForApp(colorChoice, status.isEnabled, launchSpace(view, status, pickedProfileId), presets, fallback, customTheme);
  return launchLookFor(look, savedPreferredScheme());
}

const writer = launchLookWriter(currentLaunchLook, (saved) => {
  rememberLaunchLook(saved);
});

export const rememberLaunchLookOnLeaving = () => writer.leave();

export function useLaunchLook(look: ProfileLook, ready: boolean, lookPresets: readonly PresetSpec[], lookFallback: string) {
  presets = lookPresets;
  fallback = lookFallback;
  const preferred = usePreferredScheme();
  const syncLoaded = useSync((s) => s.loaded);
  const picked = useSync((s) => s.pickedProfileId);
  useEffect(() => {
    writer.settle();
  }, [look, preferred, ready, syncLoaded, picked]);
}
