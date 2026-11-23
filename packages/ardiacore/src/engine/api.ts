import type { CleanedUrl } from "@ardia/core";
import type { AddressInput, SavedAddress, SavedCard } from "../autofill";
import type { CastDialog, CastRoute, DeviceChooser } from "../media";
import type { AddedFilterList, ContentBlockerState, ContentBlockerStats } from "../contentBlocker";
import type { BrowsingDataType } from "../profiles";
import type { ChromeWindowState } from "../windows";
import type { FieldProviderProfile, PasswordExportStatus, SavedPassword, SystemPanelResult, VerificationCodeSetupResult } from "../passwords";
import type { WindowRequest } from "../tabs";
import type {
  CookieRemoval, PageCookie, PasskeyAccess, SiteData, SiteDataWritten, StorageChange, WebKitCount,
} from "../webkit";
import type { DisplayMediaSource, OpenWindowRequest, WebNotification } from "../pageTypes";
import type { BookmarksCalls, BookmarksEvents } from "./generated/bookmarks";
import type { DownloadsCalls, DownloadsEvents } from "./generated/downloads";
import type { EngineCalls as EngineDomainCalls, EngineEvents as EngineDomainEvents } from "./generated/engine";
import type { ExtensionsCalls, ExtensionsEvents } from "./generated/extensions";
import type { FaviconsCalls, FaviconsEvents } from "./generated/favicons";
import type { HistoryCalls, HistoryEvents } from "./generated/history";
import type { PermissionsCalls, PermissionsEvents } from "./generated/permissions";
import type { SearchCalls, SearchEvents } from "./generated/search";
import type { SitesCalls, SitesEvents } from "./generated/sites";
import type { TabsCalls, TabsEvents } from "./generated/tabs";
import type { Profile } from "./wire";

type VideoUpscalingState = { enabled: boolean; lowPower: boolean; thermalPressure: boolean; appActive: boolean; tabs: { tabId: number; allowed: boolean; capturing: boolean }[] };

export type EngineCalls = BookmarksCalls & DownloadsCalls & EngineDomainCalls & ExtensionsCalls & FaviconsCalls & HistoryCalls & PermissionsCalls & SearchCalls & SitesCalls & TabsCalls & {
  "windows.list": [{}, ChromeWindowState[]];
  "windows.dev": [{ window: number; action: string }, string];

  "profiles.loaded": [{}, { profiles: string[] }];
  "profiles.ctrlTabMru": [{}, { profiles: Record<string, boolean> }];
  "profiles.release": [Profile, null];
  "profiles.unloadIdle": [Profile, { status: "released" | "pending" | "busy"; tabs: string[]; heldBy?: string }];
  "profiles.deleteData": [Profile, { remaining: string[] }];
  "profiles.clearBrowsingData": [Profile & { types: BrowsingDataType[]; since: number | null }, null];

  "passwords.list": [Profile, { passwords: SavedPassword[] }];
  "passwords.unlock": [Profile, { unlocked: boolean }];
  "passwords.reveal": [Profile & { origin: string; username: string }, { password: string | null }];
  "passwords.remove": [Profile & { origin: string; username: string }, { ok: true }];
  "passwords.neverSaveOrigins": [Profile, { origins: string[] }];
  "passwords.allowSaving": [Profile & { origin: string }, { ok: true }];
  "passwords.export": [Profile, { status: PasswordExportStatus; path?: string }];
  "passwords.autofillEnabled": [Profile, boolean];
  "passwords.setAutofillEnabled": [Profile & { enabled: boolean }, null];
  "passwords.setFieldProviders": [{ session: string; generation: number; profiles: FieldProviderProfile[] }, { applied: boolean }];
  "passwords.showSystemPanel": [{ tab: string; generation?: number }, SystemPanelResult];
  "passwords.showPanelHint": [{ tab: string; label: string; side: "above" | "below" }, { shown: boolean }];
  "passwords.systemPanelAvailable": [{}, { chromium: boolean; webkit: boolean }];
  "passwords.otpauthHandler": [{}, { app: string | null }];
  "passwords.setUpVerificationCode": [{ tab: string; token: string; generation?: number }, VerificationCodeSetupResult];

  "autofill.settings": [Profile, { addresses: boolean; cards: boolean }];
  "autofill.setSettings": [Profile & { addresses?: boolean; cards?: boolean }, null];
  "autofill.addresses": [Profile, { addresses: SavedAddress[] }];
  "autofill.saveAddress": [Profile & { address: AddressInput }, { id: string }];
  "autofill.cards": [Profile, { cards: SavedCard[] }];
  "autofill.remove": [Profile & { id: string }, { ok: true }];
  "autofill.cardNumber": [Profile & { id: string }, { number?: string | null }];
  "autofill.showSuggestions": [{ tabId: string; passwords: boolean }, boolean];

  "media.displayMediaSources": [{}, DisplayMediaSource[]];
  "media.displayMediaThumbnails": [{ ids: string[]; width: number }, Record<string, string>];
  "media.screenRecordingAllowed": [{}, boolean];
  "media.requestScreenRecording": [{}, boolean];
  "media.selectDevice": [{ id: number; index: number }, null];
  "media.cancelDeviceChooser": [{ id: number }, null];
  "media.refreshDeviceChooser": [{ id: number }, null];
  "media.openBluetoothSettings": [{ id: number }, null];
  "media.devShowBluetoothChooser": [{ tabId: string; unauthorized: boolean }, boolean];
  "media.devChooserEvents": [{}, Record<string, unknown>[]];
  "media.showCastDialog": [{ tabId: string }, boolean];
  "media.startCasting": [{ id: number; sink: string; mode: number }, null];
  "media.stopCasting": [{ id: number; route: string }, null];
  "media.closeCastDialog": [{ id: number }, null];
  "media.watchCastRoutes": [Profile, null];
  "media.terminateCastRoute": [{ route: string }, null];
  "media.changeCaptureSource": [{ capturer: string; target: string }, boolean];
  "media.stopCapture": [{ tabId: string }, boolean];

  "contentBlocker.state": [{}, ContentBlockerState];
  "contentBlocker.setEnabled": [{ enabled: boolean }, null];
  "contentBlocker.setListEnabled": [{ id: string; enabled: boolean }, null];
  "contentBlocker.addList": [{ url: string }, AddedFilterList];
  "contentBlocker.removeList": [{ id: string }, null];
  "contentBlocker.isAllowed": [{ host: string }, boolean];
  "contentBlocker.setAllowed": [{ host: string; allowed: boolean }, null];
  "contentBlocker.removeAllowed": [{ host: string }, { removed: boolean }];
  "contentBlocker.hiddenElements": [{ profile: string }, string[]];
  "contentBlocker.hideElements": [{ profile: string; filters: string[] }, null];
  "contentBlocker.restoreElements": [{ profile: string; filters: string[] }, null];
  "contentBlocker.devFailNextMessage": [{}, null];
  "contentBlocker.devDelayNextLoad": [{ ms: number }, null];
  "webView.setDisplayMediaPicker": [{ enabled: boolean }, null];
  "webView.setPeekModifier": [{ modifier: "alt" | "shift" | "off" }, null];
  "webView.setSplitLinkModifier": [{ modifier: "alt" | "altShift" }, null];
  "webView.setPeekOtherSiteTabs": [{ tabIds: string[] }, null];
  "webView.setSelectionPopover": [{ enabled: boolean }, null];
  "webView.setBlockAutoplayEverywhere": [{ enabled: boolean }, null];
  "webView.setCommandScrollZoom": [{ enabled: boolean }, null];
  "webView.setLittleArdiaOpensNewTabLinks": [{ enabled: boolean }, null];
  "webView.setPopupsOpenAsTabs": [{ enabled: boolean }, null];
  "webView.setAutoPictureInPicture": [{ enabled: boolean }, null];
  "webView.setVideoUpscaling": [{ enabled: boolean }, null];
  "webView.setVideoUpscalingTestConditions": [{ lowPower?: boolean; thermalPressure?: boolean; capturing?: boolean }, null];
  "webView.videoUpscalingState": [{}, VideoUpscalingState | null];
  "webView.takeContentDrift": [{}, { layouts: number; fits: number; maxPoints: number }];
  "webView.takeFirstPaintHolds": [{}, { held: number; painted: number; loaded: number; pressed: number; timedOut: number; heldMs: number }];

  "webKit.removeDownloadStaging": [{ path: string }, boolean];
  "webKit.endPrivateSession": [{ session: string }, null];
  "webKit.cookieStoreKey": [Profile, string];
  "webKit.importCookies": [Profile & { storeKey: string; cookies: PageCookie[] }, number];
  "webKit.exportCookies": [Profile & { urls: string[]; keys?: string[] }, number];
  "webKit.watchSiteData": [{ enabled: boolean }, null];
  "webKit.siteDataReady": [{ id: string }, null];
  "webKit.readSiteData": [Profile & { domains: string[]; origins: string[] }, SiteData | null];
  "webKit.writeSiteData": [Profile & { set: PageCookie[]; remove: CookieRemoval[]; storage: Record<string, StorageChange> }, SiteDataWritten | null];
  "webKit.setZoom": [Profile & { host: string; zoom: number }, null];
  "webKit.setFraudWarnings": [{ enabled: boolean }, null];
  "webKit.writeCopiedAddress": [{ request: number; url: CleanedUrl }, boolean];
  "webKit.devStoreExists": [Profile, boolean];
  "webKit.devTouchStore": [Profile, boolean];
  "webKit.devHoldStore": [Profile, null];
  "webKit.devParkedTransfers": [{}, string[]];
  "webKit.devContentBlocker": [{}, Record<string, unknown>];
  "webKit.passkeyAccess": [{}, PasskeyAccess];
  "webKit.notificationAction": [{ id: string; action: "click" | "close" }, null];
  "webKit.requestPasskeyAccess": [{}, PasskeyAccess];
};

export type EngineEvents = BookmarksEvents & DownloadsEvents & EngineDomainEvents & ExtensionsEvents & FaviconsEvents & HistoryEvents & PermissionsEvents & SearchEvents & SitesEvents & TabsEvents & {
  "webKit.counted": { name: WebKitCount; epoch?: string };
  "webKit.copyAddress": { url: string; request: number; epoch?: string };
  "webKit.siteDataWanted": { id: string; profile: string; origin: string; epoch?: string };
  "webKit.siteCookiesChanged": { profile: string; domains: string[]; epoch?: string };
  "webKit.notification": { profile: string; notification: WebNotification; epoch?: string };
  "webKit.notificationClose": { id: string };
  "webKit.openWindow": OpenWindowRequest & { profile: string };
  "contentBlocker.changed": ContentBlockerStats;
  "profiles.loaded": { profile: string };
  "media.deviceChooser": DeviceChooser;
  "media.castDialog": CastDialog;
  "media.castRoutes": { profile: string; routes: CastRoute[] };
};

export type WindowsHostEvents = {
  "tabs.windowRequest": WindowRequest;
};

export type LinuxHostEvents = {
  "reauth.requested": { purpose: string; granted: boolean; result: string; method?: "polkit" | "loginPassword" };
};
