import { useMemo } from "react";
import type { MaterialScheme } from "../../lib/material/schemes";
import { schemeFor, schemePairFor } from "../../lib/material/schemePick";
import { useDynamicScheme } from "../../state/app/dynamicScheme";
import { currentDarkScheme, useAppearanceDesign, useDarkScheme } from "../../state/settings/appearance";
import { currentPreferences, usePreferences } from "../../state/settings/store";
import { ink } from "./tokens";

export type MaterialTheme = { scheme: MaterialScheme; dark: boolean };

export function useMaterialSchemePair() {
  const choice = usePreferences((p) => p.colorChoice);
  const enabled = usePreferences((p) => p.dynamicColors);
  const dynamic = useDynamicScheme((s) => s.pair);
  return useMemo(() => schemePairFor(choice, dynamic, enabled), [choice, dynamic, enabled]);
}

export function useMaterialTheme(incognito = false): MaterialTheme {
  const preferredDark = useDarkScheme();
  const dark = incognito || preferredDark;
  const pair = useMaterialSchemePair();
  return useMemo(() => {
    const scheme = schemeFor(pair, dark);
    return { scheme: incognito ? { ...scheme, surface: ink.black, surfaceContainer: ink.black, surfaceContainerHigh: ink.black } : scheme, dark };
  }, [pair, dark, incognito]);
}

export function currentMaterialTheme(): MaterialTheme {
  const dark = currentDarkScheme();
  const { colorChoice, dynamicColors } = currentPreferences();
  return { scheme: schemeFor(schemePairFor(colorChoice, useDynamicScheme.getState().pair, dynamicColors), dark), dark };
}

export const materialDesignApplied = () => useAppearanceDesign.getState().design === "material";
