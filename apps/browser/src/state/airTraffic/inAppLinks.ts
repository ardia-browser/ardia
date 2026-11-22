import { focus, openWindow } from "../browser/actions";
import { isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { openLinksInMainWindow, openLittleArdia } from "../littleArdia/actions";
import { noteAirTrafficInApp, type InAppLinkVia } from "../telemetry/airTrafficCounts";
import { lastActiveProfile } from "../windows/small";
import { openInRouteGroup } from "./openAt";
import { signInLink } from "./pageLinkRoutes";
import { airTrafficRule, type OpenAs } from "./rules";
import { currentAirTraffic, targetUsableNow } from "./store";

export type InAppSource = { windowId: string; profileId: string; tabId?: string };
export type InAppRoute = { profileId: string; open: OpenAs; groupKey?: string };

export function inAppLinkRoute(url: string, from: InAppSource): InAppRoute | null {
  const config = currentAirTraffic();
  if (!config.inAppLinks || !/^https?:\/\//i.test(url) || signInLink(url) || isIncognitoProfile(from.profileId)) return null;
  const s = useBrowser.getState();
  const w = s.windows[from.windowId];
  if (!w || w.kind === "private" || (from.tabId !== undefined && !s.tabs[from.tabId])) return null;
  const ruled = airTrafficRule(config, url, null, targetUsableNow);
  if (ruled?.by !== "rule") return null;
  const profileId = ruled.target.profileId ?? lastActiveProfile(s);
  if (profileId === from.profileId || !targetUsableNow(profileId, null)) return null;
  const groupKey = ruled.target.open === "tab" ? ruled.target.groupKey : undefined;
  return { profileId, open: ruled.target.open, ...(groupKey && targetUsableNow(profileId, groupKey) ? { groupKey } : {}) };
}

export function openInAppRoute(url: string, route: InAppRoute, via: InAppLinkVia) {
  noteAirTrafficInApp(via);
  if (route.open === "window") return void focus(openWindow({ url, profileId: route.profileId }));
  if (route.open === "littleArdia") return void openLittleArdia(url, route.profileId);
  if (route.groupKey) return openInRouteGroup(url, route.profileId, route.groupKey);
  openLinksInMainWindow([url], route.profileId, [undefined], true);
}

export function routedInApp(url: string, from: InAppSource, via: InAppLinkVia): boolean {
  const route = inAppLinkRoute(url, from);
  if (!route) return false;
  openInAppRoute(url, route, via);
  return true;
}

export function routePageClick(tabId: string, url: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  if (routedInApp(url, { windowId: tab.windowId, profileId: tab.profileId, tabId }, "click")) return;
  noteAirTrafficInApp("clickMiss");
  s.navigate(tabId, url, { userInitiated: false });
}
