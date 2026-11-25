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

export const PLATFORM_TERMS: PlatformTerms = { computer: "Mac", computerTitle: "Mac", os: "macOS", fileManager: "Finder", trash: "Trash", dock: "Dock", lowPowerMode: "Low Power Mode", passwordKey: "a key in your Keychain", deviceUnlock: "Touch ID or your login password", fullScreen: "macOS full screen", secretStore: "your Keychain", syncedComputer: "Mac", cloudDrive: "iCloud Drive", turnOnCloudDrive: "Turn on iCloud Drive in System Settings", cloudDriveSettingsUrl: "x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane", loginItemsSettings: "System Settings › General › Login Items", systemContrast: "macOS Increase Contrast", linkSourceApps: "Mail, Slack, Notes", linkSourceExamples: "Discord, Slack or Mail", switchTabsKey: "⌃Tab" };
