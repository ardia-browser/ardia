export const ELLIPSIS = "…";

export const opensChoice = (label: string) => `${label}${ELLIPSIS}`;

export const actionWords = {
  newTab: "New Tab",
  newIncognitoTab: "New Incognito Tab",
  clearText: "Clear Text",
  reload: "Reload",
  stopLoading: "Stop Loading",
  more: "More",
  copyLink: "Copy Link",
  copiedLink: "Copied Link",
  copiedLinkWithoutTrackers: "Copied Link Without Trackers",
  copyText: "Copy",
  copied: "Copied",
  share: "Share",
  tryAgain: "Try Again",
  open: "Open",
  setUp: "Set Up",
  showTabs: "Show Tabs",
  update: "Update",
  openSettings: "Open Settings",
  color: "Color",
} as const;

export const copiedLinkWords = (trackersRemoved: boolean) => (trackersRemoved ? actionWords.copiedLinkWithoutTrackers : actionWords.copiedLink);

export const pageWords = {
  untitledTab: actionWords.newTab,
} as const;

export const dismissWords = {
  done: "Done",
  cancel: "Cancel",
  close: "Close",
  finishEditing: "Finish Editing",
} as const;

export const destinationWords = {
  spaces: "Spaces",
  sync: "Sync With Mac",
  settings: "Settings",
  archive: "Archive",
  history: "History",
  bookmarks: "Bookmarks",
  downloads: "Downloads",
} as const;

export const syncWords = {
  connect: "Connect to Your Mac",
  connectAgain: "Connect Again",
  scanCode: "Scan Code",
  enterRecoveryPhrase: "Enter Recovery Phrase",
  syncNow: "Sync Now",
  syncing: `Syncing${ELLIPSIS}`,
} as const;

export const listWords = {
  noResults: "No Results",
  noResultsCue: (query: string) => `Check the spelling or try a new search for “${query}”.`,
  loading: `Loading${ELLIPSIS}`,
} as const;

export const connectionWords = {
  connecting: `Connecting${ELLIPSIS}`,
} as const;

export const incognitoWords = {
  closeIncognitoTabs: "Close Incognito Tabs",
} as const;

export const blockingWords = {
  blockAdsAndTrackers: "Block Ads and Trackers",
} as const;
