import { focus, openWindow } from "../browser/actions";
import { isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { openLinksInMainWindow, openLittleArdia } from "../littleArdia/actions";
import { gateOpening, isGatedUrl, settleOpening } from "../tabs/openingGate";
import { noteAirTrafficInApp, type InAppLinkVia } from "../telemetry/airTrafficCounts";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { isWindowClosing } from "../windows/closingWindows";
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
  if (!w || w.kind === "private" || isWindowClosing(from.windowId) || (from.tabId !== undefined && !s.tabs[from.tabId])) return null;
  const ruled = airTrafficRule(config, url, null, targetUsableNow);
  if (ruled?.by !== "rule") return null;
  const profileId = ruled.target.profileId ?? lastActiveProfile(s);
  if (profileId === from.profileId || !targetUsableNow(profileId, null)) return null;
  const groupKey = ruled.target.open === "tab" ? ruled.target.groupKey : undefined;
  return { profileId, open: ruled.target.open, ...(groupKey && targetUsableNow(profileId, groupKey) ? { groupKey } : {}) };
}

export function openInAppRoute(url: string, route: InAppRoute, via: InAppLinkVia, consent: ConsentToken | null) {
  noteAirTrafficInApp(via, consent);
  if (route.open === "window") return void focus(openWindow({ url, profileId: route.profileId }));
  if (route.open === "littleArdia") return void openLittleArdia(url, route.profileId);
  if (route.groupKey) return openInRouteGroup(url, route.profileId, route.groupKey);
  openLinksInMainWindow([url], route.profileId, [undefined], true);
}

export function routedInApp(url: string, from: InAppSource, via: InAppLinkVia, consent: ConsentToken | null): boolean {
  const route = inAppLinkRoute(url, from);
  if (!route) return false;
  openInAppRoute(url, route, via, consent);
  return true;
}

export function openTypedElsewhere(url: string, from: InAppSource, open: (url: string, gated: boolean) => void) {
  if (!currentAirTraffic().inAppLinks || !isGatedUrl(url)) return open(url, false);
  const consent = consentToken();
  const gated = gateOpening(url, { tabId: null, windowId: from.windowId, profileId: from.profileId, via: "newTab" }, null);
  settleOpening(gated, null, (verdict) => {
    if (verdict && "cancel" in verdict) return;
    const target = verdict?.url ?? url;
    if (!routedInApp(target, from, "typed", consent)) open(target, true);
  });
}

export function routePageClick(tabId: string, url: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  const consent = consentToken();
  if (routedInApp(url, { windowId: tab.windowId, profileId: tab.profileId, tabId }, "click", consent)) return;
  noteAirTrafficInApp("clickMiss", consent);
  s.navigate(tabId, url, { userInitiated: false });
}
