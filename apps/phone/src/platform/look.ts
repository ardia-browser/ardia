import { AccessibilityInfo, Appearance, Platform } from "react-native";

import { useLookBudgetProbe as nativeLookBudgetProbe, type SystemLook } from "@ardia/phone-native";

export { lookBudget, nativeGlassRender, systemLookNow, type LookMode, type SystemLook } from "@ardia/phone-native";

export function useLookBudgetProbe(idle: boolean, system: SystemLook) {
  nativeLookBudgetProbe(idle, system);
}

export async function systemLook(): Promise<{ reduceMotion: boolean; reduceTransparency: boolean }> {
  const [reduceMotion, reduceTransparency] = await Promise.all([
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false),
    Platform.OS === "ios" ? AccessibilityInfo.isReduceTransparencyEnabled().catch(() => false) : Promise.resolve(false),
  ]);
  return { reduceMotion, reduceTransparency };
}

export { useSystemReduceMotion, useSystemReduceTransparency } from "@ardia/phone-native";

export const overrideColorScheme = (scheme: "light" | "dark" | null) => Appearance.setColorScheme(scheme ?? "unspecified");
