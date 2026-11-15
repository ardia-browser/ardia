import { requireOptionalNativeModule } from "expo-modules-core";
import type { PlatformFeatures } from "./platformFeatures";

function onEngine(): boolean {
  try {
    return requireOptionalNativeModule<{ linuxBackend?: string }>("ArdiaApp")?.linuxBackend === "chromium";
  } catch {
    return false;
  }
}

export const PLATFORM_FEATURES: PlatformFeatures = { dock: false, appIcon: false, menuBar: false, memoryPressure: false, escapeClosesDownloads: true, dictation: false, findsBrowsersBy: "importList", hiddenBrowserSources: ["safari", "dia", "helium"], splitView: true, setsDefaultBrowser: true, exportsBookmarksAndPasswords: true, sync: true, calendar: false, webKit: false, contentBlocker: onEngine(), trackpadGestures: false, videoUpscaling: false, thinScrollBars: true, secretStoreProtection: true, haptics: false, launchLoad: false, defaultCloudDrive: false, sharesFiles: false, syncsWithPhone: false, syncsPasswords: true, extensionsInPrivate: false };
