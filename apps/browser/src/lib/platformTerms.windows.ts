import type { PlatformIds, PlatformTerms } from "./platformTerms";
import { t } from "./uiLanguage";


export const PLATFORM_IDS: PlatformIds = { report: "windows_os", otel: "windows" };

export const PLATFORM_TERMS: PlatformTerms = { computer: t(`PC`), computerTitle: t(`PC`), os: t(`Windows`), fileManager: t(`File Explorer`), trash: t(`Recycle Bin`), dock: "taskbar", lowPowerMode: t(`battery saver`), passwordKey: t(`a key Windows keeps for your account`), deviceUnlock: t(`Windows Hello or your Windows password`), fullScreen: t(`full screen`), secretStore: t(`this PC's encrypted storage`), syncedComputer: "computer", cloudDrive: t(`OneDrive`), turnOnCloudDrive: t(`Sign in to OneDrive`), cloudDriveSettingsUrl: "", loginItemsSettings: t(`Task Manager › Startup apps`), systemContrast: t(`a Windows contrast theme`), linkSourceApps: t(`Outlook, Teams, Slack`), linkSourceExamples: t(`Outlook, Teams or Slack`), switchTabsKey: "Ctrl+Tab" };
