import type { SiteSettingType } from "./siteSettings";

export type PageEngine = "chromium" | "webkit";

export type PageCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  session: boolean;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: unknown;
  partitionKeyOpaque?: boolean;
};

export type StorageItems = [string, string][];
export type SiteStorage = Record<string, StorageItems | null>;
export type SiteData = { cookies: PageCookie[]; storage: SiteStorage };
export type StorageChange = { set: StorageItems; remove: string[] };
export type CookieRemoval = { name: string; domain: string; path: string };
export type ChromiumCookieWrite = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};
export type ChromiumSiteDataRequest =
  | { op: "read"; domains: string[]; origins: string[] }
  | { op: "write"; cookies: ChromiumCookieWrite[]; remove: CookieRemoval[]; storage: Record<string, StorageChange> };
export type ChromiumSiteDataReply = Partial<SiteData> & { cookiesWritten?: number; removed?: number; storageWritten?: number };
export type SiteDataWritten = { cookies: number; removed: number; storage: number };

export type PasskeyAccessStatus = "entitlementRequired" | "deviceNotConfigured" | "notDetermined" | "authorized" | "denied";
export type PasskeyAccess = { entitled: boolean; status: PasskeyAccessStatus };

export const NO_PASSKEY_ACCESS: PasskeyAccess = { entitled: false, status: "entitlementRequired" };

export const WEBKIT_SITE_SETTINGS: readonly SiteSettingType[] = ["camera", "microphone", "location", "notifications", "popups", "javascript", "images", "cookies", "autoplay", "clipboard"];

export type WebKitExtension = {
  id: string;
  path: string | null;
  version: string;
  name: string;
  sites: string[];
  allSites: boolean;
  incognito: boolean;
};

export type WebKitExtensionsSync = { available: boolean; loaded: string[]; failed: string[] };

export type WebKitCount =
  | "autofillAddressFill"
  | "autofillCardFill"
  | "autofillCardReauthRefused"
  | "autofillAddressSaveOffer"
  | "autofillAddressSave"
  | "autofillCardSaveOffer"
  | "autofillCardSave"
  | "autofillFill"
  | "autofillSaveOffer"
  | "autofillSave"
  | "notification"
  | "autofillUpdateOffer"
  | "autofillUpdate"
  | "autofillNever"
  | "passwordsLeftToManager"
  | "cookieReplaced"
  | "workerNotification"
  | "workerShownNotification"
  | "workerClick"
  | "translation"
  | "extensionAction"
  | "shimDownloads"
  | "shimHistory"
  | "shimBookmarks"
  | "shimTabGroups"
  | "shimSidePanel"
  | "shimRuntime"
  | "shimManagement"
  | "shimIdle"
  | "shimTopSites"
  | "shimSearch"
  | "shimSessions"
  | "shimBrowsingData"
  | "shimDns"
  | "shimTts"
  | "shimOffscreen"
  | "shimStorage"
  | "shimIdentity"
  | "shimCommands"
  | "extensionShortcut"
  | "siteSettingApplied"
  | "uploadFiltered"
  | "screenShareRequest"
  | "screenShareAllowed"
  | "devTools"
  | "viewSource"
  | "savePage"
  | "savePageFailure"
  | "quarantineFailure"
  | "nativeHostLaunch"
  | "nativeHostFailure"
  | "privateExtensionLoaded"
  | "extensionTabCreate"
  | "extensionTabClose"
  | "extensionTabActivate"
  | "extensionTabPin"
  | "extensionTabDuplicate"
  | "extensionTabZoom"
  | "extensionWindowCreate"
  | "extensionWindowUpdate"
  | "extensionWindowRemove"
  | "extensionTabRequestFailed"
  | "extensionPopup"
  | "contextMenu"
  | "contextMenuExtension"
  | "linkPeek"
  | "linkSplit"
  | "littleArdiaLink"
  | "scrollZoom"
  | "sampledTint"
  | "authPrompt"
  | "authPromptBlocked"
  | "dialogSuppressedWhileHidden"
  | "certificateInterstitial"
  | "certificateProceed"
  | "popupBlocked"
  | "blockedPopupOpened"
  | "errorPageRetry"
  | "appBadge"
  | "blockerCompileFailed"
  | "blockerCosmeticApplied"
  | "blockerStrictBlocked"
  | "blockerStrictProceed"
  | "blockerUserFilters"
  | "blockerUserFiltersFailed"
  | "blockerUserFiltersIsolated"
  | "discard"
  | "discardWake"
  | "downloadSkipped"
  | "fallbackFind"
  | "faviconChanged"
  | "fullscreen"
  | "historyRestored"
  | "linkDrop"
  | "nativeFind"
  | "pageMute"
  | "pageMuteFallback"
  | "selectionShown"
  | "soundRuleMuted"
  | "unresponsive"
  | "unresponsiveEnded"
  | "webAudioAudible";

export type WebKitExtensionApi =
  | "downloads"
  | "history"
  | "bookmarks"
  | "tabGroups"
  | "sidePanel"
  | "runtime"
  | "management"
  | "idle"
  | "topSites"
  | "search"
  | "sessions"
  | "browsingData"
  | "dns"
  | "tts"
  | "offscreen"
  | "storage"
  | "identity"
  | "commands";

export type WebKitExtensionCall = {
  id: string;
  profile: string;
  base: string;
  private: boolean;
  extensionId: string;
  api: WebKitExtensionApi;
  method: string;
  apiPermissions?: Record<string, string[]>;
  args: unknown[];
  tabKeys: (string | null)[];
  windows: string[][];
  answerBy?: number;
};

export type WebKitExtensionReply = { result: unknown } | { error: string };

export type WebKitExtensionListeners = { profile: string; base: string; private: boolean; apis: WebKitExtensionApi[] };

export type WebKitExtensionEvent = { api: WebKitExtensionApi; event: string; args: unknown[] };
