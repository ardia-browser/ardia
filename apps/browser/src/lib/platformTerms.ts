import { t } from "./uiLanguage";
export type PlatformTerms = {
  computer: string;
  computerTitle: string;
  os: string;
  fileManager: string;
  trash: string;
  dock: string;
  lowPowerMode: string;
  passwordKey: string;
  deviceUnlock: string;
  fullScreen: string;
  secretStore: string;
  syncedComputer: string;
  cloudDrive: string;
  turnOnCloudDrive: string;
  cloudDriveSettingsUrl: string;
  loginItemsSettings: string;
  systemContrast: string;
  linkSourceApps: string;
  linkSourceExamples: string;
  switchTabsKey: string;
};

export type PlatformIds = { report: string; otel: string };

export const PLATFORM_IDS: PlatformIds = { report: "macos", otel: "darwin" };

export const PLATFORM_TERMS: PlatformTerms = { computer: t(`Mac`), computerTitle: t(`Mac`), os: "macOS", fileManager: t(`Finder`), trash: t(`Trash`), dock: t(`Dock`), lowPowerMode: t(`Low Power Mode`), passwordKey: t(`a key in your Keychain`), deviceUnlock: t(`Touch ID or your login password`), fullScreen: t(`macOS full screen`), secretStore: t(`your Keychain`), syncedComputer: t(`Mac`), cloudDrive: t(`iCloud Drive`), turnOnCloudDrive: t(`Turn on iCloud Drive in System Settings`), cloudDriveSettingsUrl: "x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane", loginItemsSettings: t(`System Settings › General › Login Items`), systemContrast: t(`macOS Increase Contrast`), linkSourceApps: t(`Mail, Slack, Notes`), linkSourceExamples: t(`Discord, Slack or Mail`), switchTabsKey: "⌃⇥" };
