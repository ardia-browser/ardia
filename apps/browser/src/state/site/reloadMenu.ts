import { confirm } from "../../platform/dialogs";
import { showMenu, type MenuItem } from "../../platform/menus";
import { webviews } from "../../platform/webviews";
import type { ClearSiteDataResult } from "../../platform/siteSettings";
import { clearSiteDataEverywhere } from "../engines/siteData";
import { getContentBlocker, isContentBlockerAllowed, setContentBlockerAllowed } from "../../platform/contentBlocker";
import { menuSections } from "../app/menuSections";
import { menuShortcut } from "../commands/commandShortcuts";
import { currentTab } from "../browser/current";
import { engineProfile } from "../browser/model";
import type { Tab } from "../browser/types";
import { useBrowser } from "../browser/store";
import { openSettings } from "../settings/settingsWindows";
import { showToast } from "../app/toasts";
import { withLivePage } from "../tabs/livePage";

export function siteOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export async function setSiteBlocking(tab: Pick<Tab, "id" | "windowId">, host: string, on: boolean): Promise<boolean> {
  const failed = await setContentBlockerAllowed(host, !on).then(
    () => false,
    () => true,
  );
  const allowed = await isContentBlockerAllowed(host);
  if (failed) showToast(tab.windowId, "Couldn't Change the Ad Blocker", `Blocking on ${host} is as it was. Try again.`, { icon: "exclamationmark.triangle" });
  else void webviews.get(tab.id)?.reload();
  return allowed;
}

export type SiteDataCleared = ClearSiteDataResult | "failed" | null;

const cookieCount = (cookies: number) => `${cookies} cookie${cookies === 1 ? "" : "s"}`;

export const siteDataFailed = (cleared: ClearSiteDataResult | "failed") => cleared === "failed" || (cleared.cookies === false && !cleared.storage);

export function siteDataOutcome(cleared: ClearSiteDataResult | "failed"): string {
  if (cleared === "failed" || siteDataFailed(cleared)) return "Couldn't clear this site's data. Try again";
  if (cleared.cookies === false) return "Cleared site data, but not its cookies. Try again";
  if (!cleared.storage) return cleared.cookies ? `Cleared ${cookieCount(cleared.cookies)}, but not all site data. Try again` : "Couldn't clear all of this site's data. Try again";
  return cleared.cookies ? `Cleared ${cookieCount(cleared.cookies)} and site data` : "Cleared site data";
}

export async function confirmAndClearSiteData(profileId: string, origin: string, windowId?: string, tabId?: string): Promise<SiteDataCleared> {
  const host = new URL(origin).hostname;
  const { confirmed } = await confirm({
    title: `Clear cookies and site data for ${host}?`,
    message: "You'll be signed out of this site, and its offline data will be deleted.",
    confirmTitle: "Clear",
    destructive: true,
    windowId,
  });
  if (!confirmed) return null;
  const profile = engineProfile(useBrowser.getState(), profileId);
  const result = await clearSiteDataEverywhere(profile, origin).then(
    (cleared): ClearSiteDataResult => cleared ?? { cookies: false, storage: false },
    () => "failed" as const,
  );
  const now = tabId ? currentTab(tabId) : undefined;
  if (tabId && now && now.profileId === profileId && siteOrigin(now.url) === origin && !siteDataFailed(result)) void webviews.get(tabId)?.reload();
  return result;
}

export async function clearSiteDataAfterConfirm(tab: Pick<Tab, "id" | "windowId" | "profileId">, origin: string): Promise<number | null> {
  const cleared = await confirmAndClearSiteData(tab.profileId, origin, tab.windowId, tab.id);
  if (cleared === null) return null;
  const whole = cleared !== "failed" && cleared.cookies !== false && cleared.storage;
  showToast(tab.windowId, siteDataOutcome(cleared), undefined, { icon: whole ? "trash" : "exclamationmark.triangle" });
  return cleared !== "failed" && typeof cleared.cookies === "number" ? cleared.cookies : 0;
}

type ReloadMenuState = { blocker: "on" | "off" | "offInSettings" | "unavailable" };

export function reloadMenuItems({ blocker }: ReloadMenuState): MenuItem[] {
  return menuSections(
    [
      { id: "reload", title: "Reload", symbol: "arrow.clockwise", ...menuShortcut("reload") },
      { id: "forceReload", title: "Hard Reload", symbol: "arrow.triangle.2.circlepath", ...menuShortcut("forceReload") },
    ],
    [{ id: "blocking", title: "Block Ads & Trackers", symbol: "hand.raised", checked: blocker === "on", enabled: blocker !== "unavailable" }],
    [{ id: "clearData", title: "Clear Cookies and Site Data…", symbol: "trash" }],
  );
}

export async function showReloadMenu(tabId: string) {
  const tab = currentTab(tabId);
  const origin = tab ? siteOrigin(tab.url) : null;
  if (!tab || !origin) return;
  const host = new URL(origin).hostname;
  const [state, allowed] = await Promise.all([getContentBlocker().catch(() => null), isContentBlockerAllowed(host).catch(() => false)]);
  const blocker: ReloadMenuState["blocker"] = !state ? "unavailable" : !state.enabled ? "offInSettings" : allowed ? "off" : "on";
  const choice = await showMenu(reloadMenuItems({ blocker }));
  if (choice === "blocking") {
    if (blocker === "offInSettings") return openSettings("general");
    return void setSiteBlocking(tab, host, blocker === "off");
  }
  if (choice === "reload") return void withLivePage(tabId, (page) => page.reload());
  if (choice === "forceReload") return void withLivePage(tabId, (page) => page.forceReload());
  if (choice === "clearData") return void clearSiteDataAfterConfirm(tab, origin);
}
