import { useEffect } from "react";
import { macLookOf } from "../../lib/appearance";
import { launchLookNeedsSync, launchLookOf, launchLookSourcesLoaded, launchLookWriter, type SavedLaunchLook } from "../../lib/launchLook";
import type { PresetSpec } from "../../lib/profileLook";
import { rememberLaunchLook } from "../../platform/look";
import { syncOffered } from "../sync/offer";
import { useAppearanceDesign } from "../settings/appearance";
import { currentPreferences, usePreferences } from "../settings/store";
import { syncData, useSync } from "../sync/store";
import { launchSpace } from "../sync/syncRules";
import { useBoot } from "./boot";

let presets: readonly PresetSpec[] = [];
let fallback = "";

function currentLaunchLook(): SavedLaunchLook | null {
  const { loaded, status, view, pickedProfileId } = syncData();
  const { colorChoice, customTheme, presetThemes, materialYou, schemeChoice } = currentPreferences();
  const design = useAppearanceDesign.getState().design;
  const needsSync = launchLookNeedsSync({ colorChoice, schemeChoice, design });
  if (!launchLookSourcesLoaded({ ready: useBoot.getState().ready, syncOffered: syncOffered(), syncLoaded: loaded, needsSync })) return null;
  return launchLookOf(
    {
      design,
      schemeChoice,
      colorChoice,
      customTheme,
      presetThemes,
      materialYou,
      syncEnabled: status.isEnabled,
      macLook: macLookOf(status.isEnabled, view.look),
      space: launchSpace(view, status, pickedProfileId),
    },
    presets,
    fallback,
  );
}

const writer = launchLookWriter(currentLaunchLook, (saved) => {
  rememberLaunchLook(saved);
});

export const rememberLaunchLookOnLeaving = () => writer.leave();

export function useLaunchLook(lookPresets: readonly PresetSpec[], lookFallback: string) {
  presets = lookPresets;
  fallback = lookFallback;
  useEffect(() => {
    const settle = () => writer.settle();
    const stops = [useSync.subscribe(settle), usePreferences.subscribe(settle), useAppearanceDesign.subscribe(settle), useBoot.subscribe(settle)];
    settle();
    return () => stops.forEach((stop) => stop());
  }, []);
}
