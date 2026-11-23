import type { AddressInput, AutofillFieldEvent, AutofillFillResult, CardReveal, SavedAddress, SavedCard } from "../autofill";
import type { CastDialog, CastRoute, DeviceChooser } from "../media";
import type { AddedFilterList, ContentBlockerState, ContentBlockerStats } from "../contentBlocker";
import type {
  ActionPopupRequest, ActionState, ChromeSearchEngine, ExtensionActionChange, ExtensionInstallPrompt, ExtensionPackage, ExtensionsChange, ExtensionsLoadHealth, ExtensionsSyncApplied, ExtensionsSyncApply,
  ExtensionsSyncState, ExtensionSyncIntent, InstalledExtension, SidePanelRequest, TabsRequest,
} from "../extensions";
import type { Download, DownloadSettings } from "../downloads";
import type {
  BatterySaverMode, BatterySaverState, CliControlStatus, CursorRestore, CliTabTarget, EngineComponent, EngineInfo, EngineTask, HoverLostEpisode, MemorySaverRequest, PressLoopLongReport, MemorySaverState, PopupProtectedMedia, SystemState, WindowUnpaintedRecord,
} from "../engineDomain";
import type { ExternalAppAllowance, PermissionRequest, PermissionResult } from "../permissions";
import type { BrowsingDataType } from "../profiles";
import type { ChromeWindowState } from "../windows";
import type { FieldProviderProfile, PasswordExportStatus, SavedPassword, SystemPanelResult, VerificationCodeSetupResult } from "../passwords";
import type { ClearSiteDataResult, SiteSettings, SiteSettingType, SiteSettingValue } from "../siteSettings";
import type { LinkRoute, TabStripCommand, TabStripTransaction, WindowRequest } from "../tabs";
import type {
  CookieRemoval, PageCookie, PageEngine, PasskeyAccess, SiteData, SiteDataWritten, StorageChange, StorageItems, WebKitCount,
} from "../webkit";
import type { ChromeDropdownShown, DisplayMediaSource, OpenWindowRequest, VaultPasswordStyle, WebNotification } from "../pageTypes";
import type { VaultPasskey, VaultPasskeyAnswer, VaultPasskeyDone, VaultPasskeyRequest, VaultAddTotpResult, VaultCreateLoginResult, VaultEditResult, VaultStandaloneCode, VaultStandaloneCodeAdded, VaultStandaloneCodeEdited, VaultCodeRead, VaultCodeSource, VaultCopyResult, VaultRemoveTotpResult, VaultGeneratedPassword, VaultGeneratedSaveResult, VaultItem, VaultItemPage, VaultItemsStatus, VaultSiteItems, VaultProviderId, VaultProviderState, VaultSecretField, VaultSyncResult, VaultTotp, VaultBackupStatus, VaultBackupChange, VaultBackupDeleteResult, VaultRestoreResult, VaultSignInAnswer, VaultSignInResult } from "../vaults";
import type { BookmarksCalls, BookmarksEvents } from "./generated/bookmarks";
import type { FaviconsCalls, FaviconsEvents } from "./generated/favicons";
import type { HistoryCalls, HistoryEvents } from "./generated/history";
import type { Done, Profile } from "./wire";

type VideoUpscalingState = { enabled: boolean; lowPower: boolean; thermalPressure: boolean; appActive: boolean; tabs: { tabId: number; allowed: boolean; capturing: boolean }[] };

export type EngineCalls = BookmarksCalls & FaviconsCalls & HistoryCalls & {
  "engine.info": [{}, EngineInfo];
  "engine.components": [{}, EngineComponent[]];
  "engine.tasks": [{}, EngineTask[]];
  "engine.beginTracing": [{}, boolean];
  "engine.endTracing": [{ keep: boolean }, string | null];
  "engine.isTracing": [{}, boolean];
  "engine.systemState": [{}, SystemState];
  "engine.batterySaver": [{ mode: BatterySaverMode }, BatterySaverState];
  "engine.memorySaver": [MemorySaverRequest, MemorySaverState];
  "engine.validateKeepActiveSite": [{ site: string }, { valid: boolean }];
  "engine.trimMemory": [{}, { ok: boolean }];
  "engine.openTaskManager": [{}, { ok: boolean }];
  "engine.cliControlStatus": [{}, CliControlStatus];
  "engine.setCliControl": [{ on: boolean }, CliControlStatus];
  "engine.setCliActiveTab": [{ tabId: string | null }, CliControlStatus];
  "engine.cliTabTargets": [{ tabIds: string[] }, Record<string, CliTabTarget>];
  "engine.cliOwnsTab": [{ tabId: string }, { owned: boolean; shown: boolean }];
  "engine.cliMoveOffscreen": [{ tabId: string }, { ok: boolean; reason?: string }];
  "engine.cliCloseOffscreenTabs": [{}, Done];

  "tabs.routeLinkTabs": [{ urls: string[] }, LinkRoute];
  "tabs.stripCommand": [{ id: number; command: TabStripCommand }, null];
  "tabs.strips": [{}, TabStripTransaction];
  "tabs.lastTabPolicy": [{}, { closesWindow: boolean }];
  "tabs.reportCommits": [{ on: boolean }, null];
  "tabs.devBrowserId": [{ tabId: string }, number];
  "tabs.devEvents": [{ tabId: string }, { name: string; payload: unknown }[]];
  "tabs.devWindowNumber": [{ tabId: string }, number];
  "tabs.devFocusPage": [{ tabId: string }, boolean];
  "tabs.devPagePhase": [{ tabId: string }, "waiting" | "creating" | "attached" | "closing" | null];
  "tabs.devClosePage": [{ tabId: string }, boolean];
  "tabs.devPictureInPicture": [{}, unknown[]];
  "tabs.devPictureInPictureAction": [{ action: string }, string];
  "tabs.devPostPeekMouseUp": [{ keys: string; tabId: string }, boolean];
  "tabs.devScrollZoom": [{ steps: Record<string, unknown>[]; tabId?: string }, number[]];

  "windows.list": [{}, ChromeWindowState[]];
  "windows.dev": [{ window: number; action: string }, string];

  "downloads.cancel": [{ id: string }, null];
  "downloads.pause": [{ id: string }, null];
  "downloads.resume": [{ id: string }, null];
  "downloads.keep": [{ id: string }, null];
  "downloads.settings": [Profile, DownloadSettings];
  "downloads.setSettings": [Profile & Partial<Pick<DownloadSettings, "folder" | "askWhereToSave">>, DownloadSettings];

  "permissions.resolve": [{ id: string; result: PermissionResult; remember: boolean }, null];
  "permissions.resolveExternalApp": [{ id: string; open: boolean; remember: boolean }, null];
  "permissions.externalAppAllowances": [Profile, ExternalAppAllowance[]];
  "permissions.removeExternalAppAllowance": [Profile & { origin: string; scheme: string }, null];
  "permissions.devExternalLaunches": [{}, Record<string, unknown>[]];

  "profiles.loaded": [{}, { profiles: string[] }];
  "profiles.ctrlTabMru": [{}, { profiles: Record<string, boolean> }];
  "profiles.release": [Profile, null];
  "profiles.unloadIdle": [Profile, { status: "released" | "pending" | "busy"; tabs: string[]; heldBy?: string }];
  "profiles.deleteData": [Profile, { remaining: string[] }];
  "profiles.clearBrowsingData": [Profile & { types: BrowsingDataType[]; since: number | null }, null];

  "sites.settings": [Profile & { origin: string; engine: PageEngine }, SiteSettings];
  "sites.setSetting": [Profile & { origin: string; type: SiteSettingType; value: SiteSettingValue; engine: PageEngine }, null];
  "sites.origins": [Profile, string[]];
  "sites.reset": [Profile & { origin: string }, null];
  "sites.clearData": [Profile & { origin: string; engine: PageEngine }, ClearSiteDataResult];
  "sites.zoomLevels": [Profile, Record<string, number>];
  "sites.readStorage": [Profile & { origin: string }, { items: StorageItems | null }];
  "sites.writeStorage": [Profile & { origin: string; set: StorageItems; remove: string[] }, { written: number }];
  "sites.registrableDomains": [Profile & { hosts: string[] }, { domains: string[] }];
  "sites.setZoom": [Profile & { host: string; zoom: number }, null];
  "sites.preloadPages": [Profile, boolean];
  "sites.setPreloadPages": [Profile & { on: boolean }, null];

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
  "autofill.revealCard": [Profile & { id: string; entry: string }, CardReveal];
  "autofill.copyCard": [{ entry: string }, { copied: boolean; clearsAfter?: number }];
  "autofill.fill": [{ tabId: string; kind: "address" | "card"; id: string }, AutofillFillResult];
  "autofill.claimMenuKeys": [{ tabId: string; claim: boolean }, null];
  "autofill.showSuggestions": [{ tabId: string; passwords: boolean }, boolean];

  "extensions.list": [Profile, { extensions: InstalledExtension[] }];
  "extensions.inspectUnpacked": [{ path: string }, ExtensionPackage];
  "extensions.install": [Profile & { path: string }, { id: string }];
  "extensions.installCrx": [Profile & { path: string }, { id: string }];
  "extensions.setEnabled": [Profile & { id: string; enabled: boolean }, { ok: true }];
  "extensions.uninstall": [Profile & { id: string }, { ok: true }];
  "extensions.reload": [Profile & { id: string }, { ok: true }];
  "extensions.configure": [Profile & { id: string; options: Record<string, unknown> }, { ok: true }];
  "extensions.chooseFolder": [{}, string | null];
  "extensions.resolveInstallPrompt": [Profile & { requestId: string; accepted: boolean }, null];
  "extensions.actionStates": [Profile & { tabId: string; ids: string[] }, Record<string, ActionState>];
  "extensions.sidePanelUrl": [Profile & { tabId: string; extensionId: string }, string | null];
  "extensions.watchActions": [Profile, Done];
  "extensions.syncState": [Profile, ExtensionsSyncState];
  "extensions.syncApply": [Profile & ExtensionsSyncApply, ExtensionsSyncApplied];
  "extensions.loadHealth": [Profile, ExtensionsLoadHealth];

  "search.engines": [Profile, { list: { engines: ChromeSearchEngine[] } }];
  "search.setEngineName": [{ name: string; keyword?: string; url?: string }, null];
  "search.suggest": [Profile & { url: string; id: number }, { status: number; body?: string; netError?: number; stopped?: true }];
  "search.stopSuggest": [Profile & { id: number }, Done];

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
  "webView.setVaultContextMenu": [{ autofill: boolean; generate: { style: string; title: string }[]; generateAnyField?: boolean }, null];
  "webView.setVaultCodeSetup": [{ enabled: boolean }, null];
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
  "webKit.devStoreExists": [Profile, boolean];
  "webKit.devTouchStore": [Profile, boolean];
  "webKit.devHoldStore": [Profile, null];
  "webKit.devParkedTransfers": [{}, string[]];
  "webKit.devContentBlocker": [{}, Record<string, unknown>];
  "webKit.passkeyAccess": [{}, PasskeyAccess];
  "webKit.notificationAction": [{ id: string; action: "click" | "close" }, null];
  "webKit.requestPasskeyAccess": [{}, PasskeyAccess];

  "vaults.providers": [{}, VaultProviderState[]];
  "vaults.claimChromeDropdowns": [{ tabId: string; kinds: ChromeDropdownShown[]; usernames: string[]; anyLogin?: boolean }, { hidden: boolean; showing: ChromeDropdownShown[]; logins: string[] }];
  "vaults.refresh": [{ provider: VaultProviderId; ardiaProfiles?: string[] }, VaultProviderState];
  "vaults.siteItems": [{ origin: string }, VaultSiteItems];
  "vaults.searchItems": [{ query: string; limit?: number; ardiaProfile?: string | null }, VaultItem[]];
  "vaults.listItems": [{ query?: string; offset?: number; limit: number; managersOnly?: boolean; ardiaProfile?: string | null }, VaultItemPage];
  "vaults.usernames": [{ email: boolean; limit?: number; ardiaProfile?: string | null }, VaultItem[]];
  "vaults.itemsStatus": [{}, VaultItemsStatus];
  "vaults.lock": [{ provider: VaultProviderId }, VaultProviderState];
  "vaults.signOut": [{ provider: VaultProviderId }, VaultProviderState];
  "vaults.configure": [{ provider: VaultProviderId; server?: string | null }, VaultProviderState];
  "vaults.cancelSignIn": [{ provider: VaultProviderId }, VaultProviderState];
  "vaults.answer": [{ provider: VaultProviderId } & VaultSignInAnswer, VaultSignInResult];
  "vaults.copy": [{ provider: VaultProviderId; id: string; field: VaultSecretField }, VaultCopyResult];
  "vaults.totp": [{ provider: VaultProviderId; id: string }, VaultTotp | null];
  "vaults.generate": [{ style?: VaultPasswordStyle; maxLength?: number }, { length: number }];
  "vaults.setOptions": [
    { idleLockMinutes: number; touchID: boolean; askBeforeFilling: boolean; iCloudSync: boolean; lockOnQuit: boolean; lockOnScreenLock: boolean },
    Record<string, never>,
  ];
  "vaults.export": [{ provider: VaultProviderId; profile?: string }, { saved: boolean; count: number; declined?: boolean }];
  "vaults.sync": [{}, VaultSyncResult];
  "vaults.syncStatus": [{}, VaultSyncResult];
  "vaults.warm": [{ origin: string }, Record<string, never>];
  "vaults.backupStatus": [{ profiles: string[] }, VaultBackupStatus];
  "vaults.restoreBackup": [{ profiles: string[] }, VaultRestoreResult];
  "vaults.updateFromBackup": [{ profiles: string[] }, VaultRestoreResult];
  "vaults.deleteBackup": [{}, VaultBackupDeleteResult];
  "vaults.resumeBackup": [{}, Record<string, never>];
  "vaults.biometrics": [{}, { available: boolean }];
  "vaults.keychainCounts": [
    {},
    {
      reads: number;
      readsFromMemory: number;
      writesSkipped: number;
      loginKeychainCalls: number;
      storeLegacyMigrated?: number;
      storeNewerFormatKept?: number;
      storeCloudNewerFormatKept?: number;
      catalogBuilds?: number;
      catalogBuildsSlow?: number;
      storeUnreadableKept?: number;
      storeKeyReadFailed?: number;
      staleWorkDropped?: number;
      storeResealed?: number;
      storeSetAside?: number;
      storeKeyNotNoted?: number;
      credential?: { calls?: Record<string, number>; callFailures?: Record<string, number>; verbRefusals?: Record<string, number> };
    },
  ];
  "vaults.listGenerated": [{}, VaultGeneratedPassword[]];
  "vaults.copyGenerated": [{ id: string }, VaultCopyResult];
  "vaults.saveGenerated": [{ id: string; provider: VaultProviderId; username?: string; profile?: string }, VaultGeneratedSaveResult];
  "vaults.deleteGenerated": [{ id: string }, { deleted: boolean }];
  "vaults.setGeneratedRetention": [{ days: number }, Record<string, never>];
  "vaults.addTotp": [{ provider: VaultProviderId; id: string; token: string }, VaultAddTotpResult];
  "vaults.edit": [{ provider: VaultProviderId; id: string; profile?: string; username?: string; passwordDraft?: string; url?: string; totp?: { token: string } | { remove: true } }, VaultEditResult];
  "vaults.removeTotp": [{ provider: VaultProviderId; id: string }, VaultRemoveTotpResult];
  "vaults.readCode": [{ source: VaultCodeSource; origin?: string; tabId?: string }, VaultCodeRead];
  "vaults.forgetCode": [{ token: string }, Record<string, never>];
  "vaults.copyCode": [{ provider: VaultProviderId; id: string }, VaultCopyResult];
  "vaults.ardiaLoginChanged": [{ profile: string; origin: string; username: string; to?: string | null }, boolean];
  "vaults.importCodes": [{ profile: string; path: string }, { imported: number; standalone?: number }];
  "vaults.dropTouchGrant": [{}, Record<string, never>];
  "vaults.copyConcealed": [{ text: string }, VaultCopyResult];
  "vaults.newPasswordDraft": [{ style?: VaultPasswordStyle }, { token: string; length: number }];
  "vaults.dropPasswordDraft": [{ token: string }, Record<string, never>];
  "vaults.createLogin": [{ website: string; username?: string; passwordDraft: string; profile?: string; codeToken?: string }, VaultCreateLoginResult];
  "vaults.codes": [{}, VaultStandaloneCode[]];
  "vaults.addCode": [{ token: string; label: string; issuer?: string; website?: string }, VaultStandaloneCodeAdded];
  "vaults.editCode": [{ id: string; label: string; website?: string }, VaultStandaloneCodeEdited];
  "vaults.deleteCode": [{ id: string }, { deleted: boolean; error?: "notFound" | "declined" | "failed" }];
  "vaults.passkeys": [{}, VaultPasskey[]];
  "vaults.deletePasskey": [{ id: string }, { deleted: boolean; error?: "notFound" | "declined" | "failed" }];
  "vaults.passkeyAnswer": [{ requestId: string; choice: string; target?: string }, VaultPasskeyAnswer];
  "vaults.setPasskeys": [{ source?: string; extensions?: { id: string; name: string; known?: boolean }[] }, Record<string, never>];
};

export type EngineEvents = BookmarksEvents & FaviconsEvents & HistoryEvents & {
  "engine.systemState": SystemState;
  "engine.cliControl": CliControlStatus;
  "engine.hoverLost": HoverLostEpisode;
  "engine.popupProtectedMedia": PopupProtectedMedia;
  "engine.devToolsKeyKept": { epoch: string };
  "engine.cursorRestored": CursorRestore;
  "engine.windowUnpainted": WindowUnpaintedRecord;
  "engine.pressLoopLong": PressLoopLongReport;
  "tabs.strips": TabStripTransaction;
  "downloads.changed": Download;
  "permissions.requested": PermissionRequest;
  "permissions.dismissed": { id: string };
  "webKit.counted": { name: WebKitCount; epoch?: string };
  "webKit.siteDataWanted": { id: string; profile: string; origin: string; epoch?: string };
  "webKit.siteCookiesChanged": { profile: string; domains: string[]; epoch?: string };
  "webKit.notification": { profile: string; notification: WebNotification; epoch?: string };
  "webKit.notificationClose": { id: string };
  "webKit.openWindow": OpenWindowRequest & { profile: string };
  "contentBlocker.changed": ContentBlockerStats;
  "extensions.changed": ExtensionsChange;
  "extensions.tabs": TabsRequest;
  "extensions.installPrompt": ExtensionInstallPrompt;
  "extensions.installFailed": { message: string; tabId: string | null };
  "extensions.sidePanel": SidePanelRequest;
  "extensions.actionPopup": ActionPopupRequest;
  "extensions.actionShortcut": ActionPopupRequest;
  "extensions.action": ExtensionActionChange;
  "extensions.sync": { profile: string } & ExtensionSyncIntent;
  "profiles.loaded": { profile: string };
  "media.deviceChooser": DeviceChooser;
  "media.castDialog": CastDialog;
  "media.castRoutes": { profile: string; routes: CastRoute[] };
  "vaults.changed": { provider: VaultProviderState; removed?: boolean };
  "vaults.openApproval": { provider: VaultProviderId; url: string };
  "vaults.itemsChanged": { provider: VaultProviderId; revision: number };
  "vaults.generatedChanged": Record<string, never>;
  "vaults.backupChanged": VaultBackupChange;
  "vaults.codesChanged": Record<string, never>;
  "vaults.passkeyRequest": VaultPasskeyRequest;
  "vaults.passkeyOffer": VaultPasskeyRequest;
  "vaults.passkeyDone": VaultPasskeyDone;
  "vaults.passkeysChanged": Record<string, never>;
  "autofill.field": AutofillFieldEvent;
  "autofill.menuKey": { tabId: string; key: "ArrowUp" | "ArrowDown" | "Enter" | "Escape" | "Tab"; epoch?: string };
};

export type WindowsHostEvents = {
  "tabs.windowRequest": WindowRequest;
};

export type LinuxHostEvents = {
  "reauth.requested": { purpose: string; granted: boolean; result: string; method?: "polkit" | "loginPassword" };
};
