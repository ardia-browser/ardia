import type { PlatformIds, PlatformTerms } from "./platformTerms";
import { t } from "./uiLanguage";


export const PLATFORM_IDS: PlatformIds = { report: "linux", otel: "linux" };

export const PLATFORM_TERMS: PlatformTerms = { computer: "computer", computerTitle: t(`Computer`), os: t(`Linux`), fileManager: t(`Files`), trash: t(`Trash`), dock: "panel", lowPowerMode: t(`power saver mode`), passwordKey: t(`a key in your keyring`), deviceUnlock: t(`your system password`), fullScreen: t(`full screen`), secretStore: t(`your keyring`), syncedComputer: "computer", cloudDrive: t(`Syncthing, Nextcloud or Dropbox`), turnOnCloudDrive: t(`Choose a synced folder`), cloudDriveSettingsUrl: "", loginItemsSettings: t(`your desktop's Startup Applications`), systemContrast: t(`the desktop's high contrast setting`), linkSourceApps: t(`Thunderbird, Slack`), linkSourceExamples: t(`Discord, Slack or Thunderbird`), switchTabsKey: "Ctrl+Tab" };
