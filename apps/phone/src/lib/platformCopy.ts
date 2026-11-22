import { t } from "./uiLanguage";
export type CopyPlatform = "android" | "ios";

export type DefaultBrowserSteps = { title: string; subtitle: string; steps: string[]; action: string };

export type ImportFailedCopy = { title: string; body: string; tryAgain: string; tryingAgain: string; startWithout: string; startWithoutNote: string };

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
  stopSyncAsActionSheet: boolean;
  menuRowTogglesSwitch: boolean;
  menuLargeTextScale: number;
  pinFeedbackInMenu: boolean;
  findWaitsForMenu: boolean;
  menuTitleBelowAtLargeText: boolean;
};

const ANDROID: PlatformCopy = {
  importFailed: {
    title: t(`Couldn’t Bring Over Your Tabs`),
    body: t(`Ardia couldn’t bring over the tabs and settings from the previous version. They’re still on this phone.`),
    tryAgain: t(`Try Again`),
    tryingAgain: t(`Trying Again…`),
    startWithout: t(`Start Without Them`),
    startWithoutNote: t(`They stay on this phone, so a later version can still bring them over.`),
  },
  thisDevice: t(`This Phone`),
  deviceNameHeader: t(`This Phone’s Name`),
  syncHero: t(`Your Mac’s tabs here, and this phone’s on your Mac.`),
  syncTabsStay: t(`Tabs on this phone stay.`),
  stopSyncingFooter: t(`Your Mac stops seeing this phone’s tabs.`),
  syncFeatureFooter: t(`End-to-end encrypted, in a folder you choose.`),
  phraseStays: t(`Your recovery phrase stays on this phone.`),
  keySaveFailed: t(`Couldn’t save the sync key on this phone.`),
  folderUnavailable: t(`Ardia can’t open this folder. Choose the Ardia Sync folder your Mac syncs to.`),
  chooseFolderDetail: t(`Choose the Ardia Sync folder your Mac syncs to.`),
  historyClears: t(`History clears from this phone. Your Mac’s history stays on your Mac.`),
  privacy: t(`No accounts. Your data stays on your devices and in the sync folder you choose.`),
  ardiaCredit: t(`This app, and the Mac browser it syncs with.`),
  cantScanTitle: t(`Can’t Scan on This Phone`),
  alreadyPinnedToast: t(`Pinned to Your Mac`),
  filterRulesUnsupported: t(`Some rules need features Ardia can’t run.`),
  readerSerif: { label: t(`Serif`), family: "serif" },
  readerSans: { label: t(`Sans Serif`), family: "sans-serif" },
  voicePermission: t(`Allow Microphone for Ardia in Settings to search with your voice.`),
  defaultBrowserInstructions: null,
  offersDefaultBrowserAlways: true,
  untitledTabByAddress: true,
  devicesShowLastSeen: true,
  devicesNameMacModels: false,
  stopSyncAsActionSheet: false,
  menuRowTogglesSwitch: true,
  menuLargeTextScale: 1.3,
  pinFeedbackInMenu: false,
  findWaitsForMenu: false,
  menuTitleBelowAtLargeText: false,
};

const IOS: PlatformCopy = {
  importFailed: {
    title: t(`Couldn’t Bring Over Your Tabs`),
    body: t(`Ardia couldn’t bring over the tabs and settings from the previous version. They’re still on this iPhone.`),
    tryAgain: t(`Try Again`),
    tryingAgain: t(`Trying Again…`),
    startWithout: t(`Start Without Them`),
    startWithoutNote: t(`They stay on this iPhone, so a later version can still bring them over.`),
  },
  thisDevice: t(`This iPhone`),
  deviceNameHeader: t(`This iPhone’s Name`),
  syncHero: t(`Your Mac’s tabs here, and this iPhone’s on your Mac.`),
  syncTabsStay: t(`Tabs on this iPhone stay.`),
  stopSyncingFooter: t(`Your Mac stops seeing this iPhone’s tabs.`),
  syncFeatureFooter: t(`End-to-end encrypted, in your own iCloud Drive.`),
  phraseStays: t(`Your recovery phrase stays in this iPhone’s Keychain.`),
  keySaveFailed: t(`Couldn’t save the sync key in your Keychain.`),
  folderUnavailable: t(`Ardia can’t open this folder. Choose the Ardia Sync folder in iCloud Drive.`),
  chooseFolderDetail: t(`Choose the Ardia Sync folder in iCloud Drive.`),
  historyClears: t(`History clears from this iPhone. Your Mac’s history stays on your Mac.`),
  privacy: t(`No accounts. Your data stays on your devices and in your iCloud Drive.`),
  ardiaCredit: t(`This app, and the Mac browser it syncs with.`),
  cantScanTitle: t(`Can’t Scan on This iPhone`),
  alreadyPinnedToast: t(`Already Pinned to Your Mac`),
  filterRulesUnsupported: t(`Some rules need features Safari can’t run.`),
  readerSerif: { label: t(`New York`), family: "ui-serif" },
  readerSans: { label: t(`San Francisco`), family: "ui-sans-serif" },
  voicePermission: t(`Allow Microphone and Speech Recognition for Ardia in Settings to search with your voice.`),
  defaultBrowserInstructions: {
    title: t(`How to change your default browser`),
    subtitle: t(`Open links from other apps in Ardia.`),
    steps: [t(`Open Ardia in Settings`), t(`Tap on “Default Browser App”`), t(`Select Ardia`)],
    action: t(`Open Ardia in Settings`),
  },
  offersDefaultBrowserAlways: false,
  untitledTabByAddress: false,
  devicesShowLastSeen: false,
  devicesNameMacModels: true,
  stopSyncAsActionSheet: true,
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
  android: { historyClears: t(`History clears from this phone.`), privacy: t(`No accounts. Your data stays on this phone.`), ardiaCredit: t(`This app.`) },
  ios: { historyClears: t(`History clears from this iPhone.`), privacy: t(`No accounts. Your data stays on this iPhone.`), ardiaCredit: t(`This app.`) },
};

export function selectCopy(os: string, offersSync = true) {
  const platform: CopyPlatform = os === "ios" ? "ios" : "android";
  current = offersSync ? TABLES[platform] : { ...TABLES[platform], ...SYNC_FREE[platform] };
}

export const copy = (): PlatformCopy => current;
