import type { CastDialog, CastRoute, DeviceChooser } from "../media";
import type { DisplayMediaSource } from "../pageTypes";
import type { WindowRequest } from "../tabs";
import type { AutofillCalls, AutofillEvents } from "./generated/autofill";
import type { BookmarksCalls, BookmarksEvents } from "./generated/bookmarks";
import type { ContentBlockerCalls, ContentBlockerEvents } from "./generated/contentBlocker";
import type { DownloadsCalls, DownloadsEvents } from "./generated/downloads";
import type { EngineCalls as EngineDomainCalls, EngineEvents as EngineDomainEvents } from "./generated/engine";
import type { ExtensionsCalls, ExtensionsEvents } from "./generated/extensions";
import type { FaviconsCalls, FaviconsEvents } from "./generated/favicons";
import type { HistoryCalls, HistoryEvents } from "./generated/history";
import type { PasswordsCalls, PasswordsEvents } from "./generated/passwords";
import type { PermissionsCalls, PermissionsEvents } from "./generated/permissions";
import type { ProfilesCalls, ProfilesEvents } from "./generated/profiles";
import type { SearchCalls, SearchEvents } from "./generated/search";
import type { SitesCalls, SitesEvents } from "./generated/sites";
import type { TabsCalls, TabsEvents } from "./generated/tabs";
import type { WebKitCalls, WebKitEvents } from "./generated/webKit";
import type { WebViewCalls, WebViewEvents } from "./generated/webView";
import type { WindowsCalls, WindowsEvents } from "./generated/windows";
import type { Profile } from "./wire";

export type EngineCalls = AutofillCalls & BookmarksCalls & ContentBlockerCalls & DownloadsCalls & EngineDomainCalls & ExtensionsCalls & FaviconsCalls & HistoryCalls & PasswordsCalls & PermissionsCalls & ProfilesCalls & SearchCalls & SitesCalls & TabsCalls & WebKitCalls & WebViewCalls & WindowsCalls & {
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
};

export type EngineEvents = AutofillEvents & BookmarksEvents & ContentBlockerEvents & DownloadsEvents & EngineDomainEvents & ExtensionsEvents & FaviconsEvents & HistoryEvents & PasswordsEvents & PermissionsEvents & ProfilesEvents & SearchEvents & SitesEvents & TabsEvents & WebKitEvents & WebViewEvents & WindowsEvents & {
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
