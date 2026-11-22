import { getSiteSettings, setSiteSetting, WEBKIT_SITE_SETTINGS, type SiteSettings, type SiteSettingType, type SiteSettingValue } from "../../platform/siteSettings";
import type { PageEngine } from "../../platform/tabs";
import { currentLive, currentMuteState } from "../browser/current";
import { setSiteMuted } from "../browser/actions";
import { pageOf } from "../tabs/pageState";
import { useBrowser } from "../browser/store";
import { ensureLocationPermission } from "./locationAccess";
import { noteSiteControls } from "../telemetry/usage";
import { consentToken } from "../telemetry/client";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { t } from "../../lib/uiLanguage";


export type SitePermission = { type: SiteSettingType; title: string; icon: string; badge: string; choices: SiteSettingValue[] };

const SITE_PERMISSIONS: SitePermission[] = [
  { type: "camera", title: t(`Camera`), icon: "video", badge: "video.fill", choices: ["ask", "allow", "block"] },
  { type: "microphone", title: t(`Microphone`), icon: "mic", badge: "mic.fill", choices: ["ask", "allow", "block"] },
  { type: "location", title: t(`Location`), icon: "location", badge: "location.fill", choices: ["ask", "allow", "block"] },
  { type: "notifications", title: t(`Notifications`), icon: "bell", badge: "bell.fill", choices: ["ask", "allow", "block"] },
  { type: "popups", title: t(`Pop-ups and Redirects`), icon: "macwindow.on.rectangle", badge: "macwindow.on.rectangle", choices: ["allow", "block"] },
  { type: "sound", title: t(`Sound`), icon: "speaker.wave.2", badge: "speaker.wave.2.fill", choices: ["allow", "block"] },
  { type: "autoplay", title: t(`Autoplay`), icon: "play.rectangle", badge: "play.rectangle.fill", choices: ["allow", "block"] },
];

export const offersSiteSetting = (type: SiteSettingType) => type !== "autoplay" || PLATFORM_FEATURES.blocksAutoplay;

export const sitePermissionsFor = (engine: PageEngine) =>
  SITE_PERMISSIONS.filter((p) => offersSiteSetting(p.type) && (engine !== "webkit" || p.type === "sound" || WEBKIT_SITE_SETTINGS.includes(p.type)));

export const choiceTitle = (type: SiteSettingType, value: SiteSettingValue) =>
  type === "sound" ? (value === "block" ? t(`Muted`) : t(`Allowed`)) : value === "allow" ? t(`Allowed`) : value === "block" ? t(`Blocked`) : t(`Ask`);

export const readSiteSettings = (profile: string, origin: string, engine: PageEngine) =>
  getSiteSettings(profile, origin, engine).catch((): SiteSettings => ({}) as SiteSettings);

export function featuredPermissions(tabId: string, settings: SiteSettings, list: SitePermission[]): Set<SiteSettingType> {
  const access = pageOf(tabId).mediaAccess;
  const inUse: Partial<Record<SiteSettingType, boolean>> = {
    camera: !!access?.camera,
    microphone: !!access?.microphone,
    sound: currentMuteState(tabId) !== null || currentLive(tabId).playingAudio,
    autoplay: useBrowser.getState().settings.blockAutoplayEverywhere,
  };
  return new Set(list.filter((p) => !settings[p.type]?.isDefault || inUse[p.type]).map((p) => p.type));
}

export type SiteSound = { siteMuted: boolean; soundBlocked: boolean };

const autoplayBlockedByDefault = (type: SiteSettingType, settings: SiteSettings | null) =>
  type === "autoplay" && !!settings?.autoplay?.isDefault && useBrowser.getState().settings.blockAutoplayEverywhere;

export const effectiveSettingValue = (type: SiteSettingType, settings: SiteSettings | null): SiteSettingValue | undefined =>
  autoplayBlockedByDefault(type, settings) ? "block" : settings?.[type]?.value;

export const permissionValue = (type: SiteSettingType, settings: SiteSettings | null, sound: SiteSound): SiteSettingValue | undefined =>
  type === "sound" ? (sound.siteMuted || sound.soundBlocked ? "block" : "allow") : effectiveSettingValue(type, settings);

export async function setSitePermission(
  page: { tabId: string; profile: string; origin: string; engine: PageEngine },
  type: SiteSettingType,
  value: SiteSettingValue,
  sound: SiteSound,
): Promise<SiteSettings | null> {
  const consent = consentToken();
  if (type === "sound") {
    setSiteMuted(page.tabId, value === "block");
    if (value === "block" || !sound.soundBlocked) return null;
    await setSiteSetting(page.profile, page.origin, "sound", "default", page.engine);
  } else await setSiteSetting(page.profile, page.origin, type, value, page.engine);
  if (type === "autoplay" && value !== "default" && value !== "ask") noteSiteControls(value === "block" ? "autoplayBlock" : "autoplayAllow", 1, consent);
  if (type === "location" && value === "allow") void ensureLocationPermission(useBrowser.getState().tabs[page.tabId]?.windowId);
  return readSiteSettings(page.profile, page.origin, page.engine);
}

export function blockerLabel(blocker: { enabled: boolean; allowed: boolean } | null, blocked: number): string {
  if (!blocker) return "…";
  if (!blocker.enabled) return t(`Off in Settings`);
  if (blocker.allowed) return t(`Off for this site`);
  return blocked > 0 ? `On · ${blocked} blocked on this page` : t(`On`);
}
