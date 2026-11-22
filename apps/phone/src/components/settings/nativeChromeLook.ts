import { settingsUI } from "@ardia/phone-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect } from "react";
import type { ChromeStyle } from "../../lib/appearance";
import { useChromeStyle } from "../../state/settings/appearance";
import { usesGlass } from "../ui";

type ChromeLookModule = { setChromeUsesGlass?: (glass: boolean) => void };

export const chromeLookBridge = { module: () => requireOptionalNativeModule<ChromeLookModule>(settingsUI.SETTINGS_UI_MODULE) };

export const nativeChromeUsesGlass = (style: ChromeStyle, glassIsNative: boolean) => style === "glass" && glassIsNative;

export function useNativeChromeUsesGlass() {
  return nativeChromeUsesGlass(useChromeStyle(), usesGlass());
}

export function usePublishNativeChromeLook() {
  const glass = useNativeChromeUsesGlass();
  useEffect(() => {
    chromeLookBridge.module()?.setChromeUsesGlass?.(glass);
  }, [glass]);
}
