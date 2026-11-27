import { actionWords } from "./sharedWords.ts";
export type CopyPlatform = "android" | "ios";

export type DefaultBrowserSteps = { title: string; subtitle: string; steps: string[]; action: string };

export type ImportFailedCopy = { title: string; body: string; tryAgain: string; startWithout: string; startWithoutNote: string };

export type PlatformCopy = {
  importFailed: ImportFailedCopy;
  thisDevice: string;
  deviceNameHeader: string;
  syncHero: string;
  syncTabsStay: string;
  stopSyncingFooter: string;
  syncFeatureFooter: string;
  phraseStays: string;
  keySaveFailed: string;
  folderUnavailable: string;
  chooseFolderDetail: string;
  historyClears: string;
  privacy: string;
  ardiaCredit: string;
  cantScanTitle: string;
  alreadyPinnedToast: string;
  filterRulesUnsupported: string;
  readerSerif: { label: string; family: string };
  readerSans: { label: string; family: string };
  voicePermission: string;
  defaultBrowserInstructions: DefaultBrowserSteps | null;
  offersDefaultBrowserAlways: boolean;
  untitledTabByAddress: boolean;
  devicesShowLastSeen: boolean;
  devicesNameMacModels: boolean;
  confirmsAsActionSheet: boolean;
  forgottenSearchLeaves: string;
  menuRowTogglesSwitch: boolean;
  menuLargeTextScale: number;
  pinFeedbackInMenu: boolean;
  findWaitsForMenu: boolean;
  menuTitleBelowAtLargeText: boolean;
};

const ANDROID: PlatformCopy = {
  importFailed: {
    title: "Couldn’t Bring Over Your Tabs",
    body: "Ardia couldn’t bring over the tabs and settings from the previous version. They’re still on this phone.",
    tryAgain: actionWords.tryAgain,
    startWithout: "Start Without Them",
    startWithoutNote: "They stay on this phone, so a later version can still bring them over.",
  },
  thisDevice: "This Phone",
  deviceNameHeader: "This Phone’s Name",
  syncHero: "Your Mac’s tabs here, and this phone’s on your Mac.",
  syncTabsStay: "Tabs on this phone stay.",
  stopSyncingFooter: "Your Mac stops seeing this phone’s tabs.",
  syncFeatureFooter: "End-to-end encrypted, in a folder you choose.",
  phraseStays: "Your recovery phrase stays on this phone.",
  keySaveFailed: "Couldn’t save the sync key on this phone.",
  folderUnavailable: "Ardia can’t open this folder. Choose the Ardia Sync folder your Mac syncs to.",
  chooseFolderDetail: "Choose the Ardia Sync folder your Mac syncs to.",
  historyClears: "History clears from this phone. Your Mac’s history stays on your Mac.",
  privacy: "No accounts. Your data stays on your devices and in the sync folder you choose.",
  ardiaCredit: "This app, and the Mac browser it syncs with.",
  cantScanTitle: "Can’t Scan on This Phone",
  alreadyPinnedToast: "Pinned to Your Mac",
  filterRulesUnsupported: "Some rules need features Ardia can’t run.",
  readerSerif: { label: "Serif", family: "serif" },
  readerSans: { label: "Sans Serif", family: "sans-serif" },
  voicePermission: "Allow Microphone for Ardia in Settings to search with your voice.",
  defaultBrowserInstructions: null,
  offersDefaultBrowserAlways: true,
  untitledTabByAddress: true,
  devicesShowLastSeen: true,
  devicesNameMacModels: false,
  confirmsAsActionSheet: false,
  forgottenSearchLeaves: "your history on this phone",
  menuRowTogglesSwitch: true,
  menuLargeTextScale: 1.3,
  pinFeedbackInMenu: false,
  findWaitsForMenu: false,
  menuTitleBelowAtLargeText: false,
};

const IOS: PlatformCopy = {
  importFailed: {
    title: "Couldn’t Bring Over Your Tabs",
    body: "Ardia couldn’t bring over the tabs and settings from the previous version. They’re still on this iPhone.",
    tryAgain: actionWords.tryAgain,
    startWithout: "Start Without Them",
    startWithoutNote: "They stay on this iPhone, so a later version can still bring them over.",
  },
  thisDevice: "This iPhone",
  deviceNameHeader: "This iPhone’s Name",
  syncHero: "Your Mac’s tabs here, and this iPhone’s on your Mac.",
  syncTabsStay: "Tabs on this iPhone stay.",
  stopSyncingFooter: "Your Mac stops seeing this iPhone’s tabs.",
  syncFeatureFooter: "End-to-end encrypted, in your own iCloud Drive.",
  phraseStays: "Your recovery phrase stays in this iPhone’s Keychain.",
  keySaveFailed: "Couldn’t save the sync key in your Keychain.",
  folderUnavailable: "Ardia can’t open this folder. Choose the Ardia Sync folder in iCloud Drive.",
  chooseFolderDetail: "Choose the Ardia Sync folder in iCloud Drive.",
  historyClears: "History clears from this iPhone. Your Mac’s history stays on your Mac.",
  privacy: "No accounts. Your data stays on your devices and in your iCloud Drive.",
  ardiaCredit: "This app, and the Mac browser it syncs with.",
  cantScanTitle: "Can’t Scan on This iPhone",
  alreadyPinnedToast: "Already Pinned to Your Mac",
  filterRulesUnsupported: "Some rules need features Safari can’t run.",
  readerSerif: { label: "New York", family: "ui-serif" },
  readerSans: { label: "San Francisco", family: "ui-sans-serif" },
  voicePermission: "Allow Microphone and Speech Recognition for Ardia in Settings to search with your voice.",
  defaultBrowserInstructions: {
    title: "How to change your default browser",
    subtitle: "Open links from other apps in Ardia.",
    steps: ["Open Ardia in Settings", "Tap on “Default Browser App”", "Select Ardia"],
    action: "Open Ardia in Settings",
  },
  offersDefaultBrowserAlways: false,
  untitledTabByAddress: false,
  devicesShowLastSeen: false,
  devicesNameMacModels: true,
  confirmsAsActionSheet: true,
  forgottenSearchLeaves: "your history on this iPhone",
  menuRowTogglesSwitch: false,
  menuLargeTextScale: 1.6,
  pinFeedbackInMenu: true,
  findWaitsForMenu: true,
  menuTitleBelowAtLargeText: true,
};

const TABLES: Record<CopyPlatform, PlatformCopy> = { android: ANDROID, ios: IOS };

let current: PlatformCopy = ANDROID;

export const copyTable = (platform: CopyPlatform): PlatformCopy => TABLES[platform];

const SYNC_FREE: Record<CopyPlatform, Pick<PlatformCopy, "historyClears" | "privacy" | "ardiaCredit">> = {
  android: { historyClears: "History clears from this phone.", privacy: "No accounts. Your data stays on this phone.", ardiaCredit: "This app." },
  ios: { historyClears: "History clears from this iPhone.", privacy: "No accounts. Your data stays on this iPhone.", ardiaCredit: "This app." },
};

export function selectCopy(os: string, offersSync = true) {
  const platform: CopyPlatform = os === "ios" ? "ios" : "android";
  current = offersSync ? TABLES[platform] : { ...TABLES[platform], ...SYNC_FREE[platform] };
}

export const copy = (): PlatformCopy => current;
