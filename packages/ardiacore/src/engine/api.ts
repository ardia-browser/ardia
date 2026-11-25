import type { WindowRequest } from "../tabs";
import type { AutofillCalls, AutofillEvents } from "./generated/autofill";
import type { BookmarksCalls, BookmarksEvents } from "./generated/bookmarks";
import type { ContentBlockerCalls, ContentBlockerEvents } from "./generated/contentBlocker";
import type { DownloadsCalls, DownloadsEvents } from "./generated/downloads";
import type { EngineCalls as EngineDomainCalls, EngineEvents as EngineDomainEvents } from "./generated/engine";
import type { ExtensionsCalls, ExtensionsEvents } from "./generated/extensions";
import type { FaviconsCalls, FaviconsEvents } from "./generated/favicons";
import type { HistoryCalls, HistoryEvents } from "./generated/history";
import type { MediaCalls, MediaEvents } from "./generated/media";
import type { PasswordsCalls, PasswordsEvents } from "./generated/passwords";
import type { PermissionsCalls, PermissionsEvents } from "./generated/permissions";
import type { ProfilesCalls, ProfilesEvents } from "./generated/profiles";
import type { SearchCalls, SearchEvents } from "./generated/search";
import type { SitesCalls, SitesEvents } from "./generated/sites";
import type { TabsCalls, TabsEvents } from "./generated/tabs";
import type { WebKitCalls, WebKitEvents } from "./generated/webKit";
import type { WebViewCalls, WebViewEvents } from "./generated/webView";
import type { WindowsCalls, WindowsEvents } from "./generated/windows";

export type EngineCalls = AutofillCalls & BookmarksCalls & ContentBlockerCalls & DownloadsCalls & EngineDomainCalls & ExtensionsCalls & FaviconsCalls & HistoryCalls & MediaCalls & PasswordsCalls & PermissionsCalls & ProfilesCalls & SearchCalls & SitesCalls & TabsCalls & WebKitCalls & WebViewCalls & WindowsCalls;

export type EngineEvents = AutofillEvents & BookmarksEvents & ContentBlockerEvents & DownloadsEvents & EngineDomainEvents & ExtensionsEvents & FaviconsEvents & HistoryEvents & MediaEvents & PasswordsEvents & PermissionsEvents & ProfilesEvents & SearchEvents & SitesEvents & TabsEvents & WebKitEvents & WebViewEvents & WindowsEvents;

export type WindowsHostEvents = {
  "tabs.windowRequest": WindowRequest;
};

export type LinuxHostEvents = {
  "reauth.requested": { purpose: string; granted: boolean; result: string; method?: "polkit" | "loginPassword" };
};
