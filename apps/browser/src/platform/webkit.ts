import type { CleanedUrl } from "@ardia/core";
import {
  call,
  on,
  NO_PASSKEY_ACCESS,
  type EngineEvents,
  type PageCookie,
  type CookieRemoval,
  type SiteData,
  type StorageChange,
  type PasskeyAccess,
  type PasskeyAccessStatus,
  type WebKitCount,
} from "@ardia/ardiacore";

export { NO_PASSKEY_ACCESS };
export type { ChromiumCookieWrite, SiteStorage, StorageItems } from "@ardia/ardiacore";
export type { CookieRemoval, SiteData, StorageChange };
export type { PasskeyAccess, PasskeyAccessStatus, PageCookie };

export const endWebKitPrivateSession = (session: string) => call("webKit.endPrivateSession", { session });
export const exportWebKitCookies = (profile: string, urls: string[], keys?: string[]) => call("webKit.exportCookies", { profile, urls, ...(keys ? { keys } : {}) });
export const setWebKitFraudWarnings = (enabled: boolean) => call("webKit.setFraudWarnings", { enabled });
export const watchWebKitSiteData = (enabled: boolean) => call("webKit.watchSiteData", { enabled });
export const releaseWebKitSiteDataGate = (id: string) => call("webKit.siteDataReady", { id });
export const readWebKitSiteData = (profile: string, domains: string[], origins: string[]) => call("webKit.readSiteData", { profile, domains, origins });
export const writeWebKitSiteData = (profile: string, set: PageCookie[], remove: CookieRemoval[], storage: Record<string, StorageChange>) =>
  call("webKit.writeSiteData", { profile, set, remove, storage });
export const onWebKitSiteDataWanted = (listener: (e: { id: string; profile: string; origin: string; epoch?: string }) => void) => on("webKit.siteDataWanted", listener);
export const onWebKitSiteCookiesChanged = (listener: (e: { profile: string; domains: string[]; epoch?: string }) => void) => on("webKit.siteCookiesChanged", listener);
export const setWebKitZoom = (profile: string, host: string, zoom: number) => call("webKit.setZoom", { profile, host, zoom });
export const onWebKitCount = (listener: (e: { name: WebKitCount; epoch?: string }) => void) => on("webKit.counted", listener);
export const onWebKitCopyAddress = (listener: (e: EngineEvents["webKit.copyAddress"]) => void) => on("webKit.copyAddress", listener);
export const writeCopiedWebKitAddress = (request: number, url: CleanedUrl) => call("webKit.writeCopiedAddress", { request, url });
export const webKitNotificationAction = (id: string, action: "click" | "close") => call("webKit.notificationAction", { id, action });
export const onWebKitNotification = (listener: (e: EngineEvents["webKit.notification"]) => void) => on("webKit.notification", listener);
export const onWebKitNotificationClose = (listener: (e: { id: string }) => void) => on("webKit.notificationClose", listener);
export const onWebKitOpenWindow = (listener: (e: EngineEvents["webKit.openWindow"]) => void) => on("webKit.openWindow", listener);
export const getPasskeyAccess = () => call("webKit.passkeyAccess");
export const requestPasskeyAccess = () => call("webKit.requestPasskeyAccess");
