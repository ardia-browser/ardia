import { discardOffered, type OpenWindowRequest } from "../../platform/tabs";
import { focus, openWindow } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { peekSourceOf } from "../peek/peek";
import { leavesSite, newTabLinkRoute, siteLanding } from "../peek/newTabLinkRoute";
import { openLittleArdia, openLinksInMainWindow } from "../littleArdia/actions";
import { isSmall, lastActiveProfile, originalProfile, privateWindowProfile } from "../windows/small";
import { openLinkInSplit, openSplitPane } from "../splits/actions";
import { airTrafficRule } from "../airTraffic/rules";
import { openInRouteGroup } from "../airTraffic/openAt";
import { currentAirTraffic, targetUsableNow } from "../airTraffic/store";
import { noteAirTrafficInAppClick, noteAirTrafficInAppLink, noteAirTrafficInAppTyped } from "../telemetry/airTrafficCounts";
import { asAdoptId, isAdoptKind } from "./adoptIds";
import { gateOpening, isGatedUrl, settleOpening } from "./openingGate";
import { noteBackgroundTab } from "./newTabNotice";
import { noteBlockedPageBehind, noteLinkTabWait } from "../telemetry/usage";
import { isBlockedPage } from "../site/contentBlocking";
import { notePeekFromShiftWindow, notePopupOpenedAsTab } from "../telemetry/popupTabCounts";
import { noteLinkTabLoad } from "../telemetry/barLoadFocus";

export type { OpenWindowRequest } from "../../platform/tabs";

type PageRef = { windowId: string; profileId: string; tabId?: string };

const UNGATED = new Set(["current", "peek", "incognito"]);
const ROUTABLE = new Set(["foreground", "background", "window", "popup"]);

export function inAppLinkRoute(url: string, page: PageRef, windowKind: string | undefined): { profileId: string; open: "tab" | "window" | "littleArdia"; groupKey?: string } | null {
  const config = currentAirTraffic();
  if (!config.inAppLinks || windowKind === "private") return null;
  const ruled = airTrafficRule(config, url, null, targetUsableNow);
  if (ruled?.by !== "rule") return null;
  const profileId = ruled.target.profileId ?? lastActiveProfile(useBrowser.getState());
  if (profileId === page.profileId || !targetUsableNow(profileId, null)) return null;
  const groupKey = ruled.target.open === "tab" ? ruled.target.groupKey : undefined;
  if (groupKey && !targetUsableNow(profileId, groupKey)) return null;
  return { profileId, open: ruled.target.open, ...(groupKey ? { groupKey } : {}) };
}

function openInAppRoute(url: string, route: { profileId: string; open: "tab" | "window" | "littleArdia"; groupKey?: string }, page: PageRef, note: () => void) {
  note();
  if (route.open === "window") return focus(openWindow({ url, profileId: route.profileId }));
  if (route.open === "littleArdia") return openLittleArdia(url, route.profileId);
  if (route.groupKey) return openInRouteGroup(url, route.profileId, route.groupKey);
  openLinksInMainWindow([url], route.profileId, [undefined], true);
}

export function routedInAppClick(url: string, page: PageRef): boolean {
  const route = inAppLinkRoute(url, page, useBrowser.getState().windows[page.windowId]?.kind);
  if (!route) return false;
  openInAppRoute(url, route, page, noteAirTrafficInAppClick);
  return true;
}

export function routedInAppTyped(url: string, page: PageRef): boolean {
  const route = inAppLinkRoute(url, page, useBrowser.getState().windows[page.windowId]?.kind);
  if (!route) return false;
  openInAppRoute(url, route, page, noteAirTrafficInAppTyped);
  return true;
}

function routedInApp(url: string, request: OpenWindowRequest, page: PageRef, windowKind: string | undefined): boolean {
  if (!ROUTABLE.has(request.disposition)) return false;
  const route = inAppLinkRoute(url, page, windowKind);
  if (!route) return false;
  if (request.adoptId) void discardOffered(request.adoptId).catch(() => false);
  openInAppRoute(url, route, page, noteAirTrafficInAppLink);
  return true;
}

export function openFromPage(request: OpenWindowRequest, page: PageRef) {
  if (request.linkWait) noteLinkTabWait(request.linkWait);
  if (UNGATED.has(request.disposition) || !isGatedUrl(request.url)) return openNow(request, page, false);
  const gated = gateOpening(request.url, { tabId: page.tabId ?? null, windowId: page.windowId, profileId: page.profileId, via: "link" }, null);
  settleOpening(gated, null, (verdict) => {
    if (verdict && "cancel" in verdict) {
      if (request.adoptId) void discardOffered(request.adoptId).catch(() => false);
      return;
    }
    const windowKind = useBrowser.getState().windows[page.windowId]?.kind;
    if (routedInApp(verdict?.url ?? request.url, request, page, windowKind)) return;
    if (!verdict) return openNow(request, page, true);
    const adoptId = asAdoptId(request.adoptId);
    if (!adoptId) return openNow({ ...request, url: verdict.url }, page, true);
    openNow(request, page, true);
    const s = useBrowser.getState();
    const tabId = Object.keys(s.tabs).find((id) => {
      const p = s.tabs[id]!.page;
      return p.kind === "adopted" && p.adopt === adoptId;
    });
    if (tabId) s.navigate(tabId, verdict.url, { userInitiated: false, gated: true });
  });
}

function openNow(request: OpenWindowRequest, page: PageRef, gated: boolean) {
  const { url, profile, point } = request;
  const disposition = opensBehind(request) ? "background" : request.disposition;
  if (disposition !== request.disposition) noteBlockedPageBehind();
  const adoptId = asAdoptId(request.adoptId);
  if (request.popup) keepPopupOpener(page);
  const s = useBrowser.getState();
  const w = s.windows[page.windowId];
  if (!w) return;
  if (request.popup) notePopupOpenedAsTab();
  const peekSource = peekSourceOf(s, page.tabId);
  if (disposition === "current" || (disposition === "peek" && (peekSource || isSmall(s, w.id)))) {
    if (page.tabId) s.navigate(page.tabId, url, { userInitiated: false });
    return;
  }
  if (disposition === "peek") {
    if (!page.tabId) return;
    const pageUrl = s.tabs[page.tabId]?.url ?? "";
    if (request.site && (w.kind !== "main" || !leavesSite(url, pageUrl))) return void s.navigate(page.tabId, url, { userInitiated: false });
    s.openPeek(page.tabId, url, point ?? null, request.site ? { landing: siteLanding(pageUrl, "source") } : {});
    return;
  }
  if (disposition === "window" && page.tabId && shiftClickPeeks(request, s.settings.peekModifier, w.kind, !!peekSource) && s.openPeek(page.tabId, url, point ?? null, { adoptId })) {
    return void notePeekFromShiftWindow();
  }
  const from = peekSource ? { ...page, tabId: peekSource } : page;
  if (isSmall(s, w.id) && disposition !== "window" && disposition !== "incognito") {
    return void s.newTab(w.id, { url, adoptId, openerId: from.tabId, profileId: from.profileId, background: true, gated });
  }
  if (disposition === "foreground" && request.fromClick && isAdoptKind(adoptId, "ardiacore") && page.tabId) {
    const route = newTabLinkRoute(s, page.tabId, url);
    if (route === "peek") return void s.openPeek(page.tabId, url, point ?? null, { adoptId });
    if (route === "otherSite") return void s.openPeek(page.tabId, url, point ?? null, { adoptId, landing: siteLanding(s.tabs[page.tabId]!.url, "tab") });
    if (route === "littleArdia") return void openLittleArdia(url, from.profileId, adoptId);
  }
  if (disposition === "split") {
    if (from.tabId) return openLinkInSplit(from.tabId, url, adoptId);
    openSplitPane(w.id, { url, adoptId });
    return;
  }
  if (disposition === "incognito") {
    const profileId = privateWindowProfile(s, w, profile);
    if (isAdoptKind(adoptId, "tab")) return void openWindow({ kind: "private", url, adoptId, profileId });
    return void openWindow({ kind: "private", url, profileId });
  }
  if (disposition === "window") {
    return void openWindow(w.kind === "private" ? { kind: "private", url, profileId: originalProfile(s, w) } : { profileId: from.profileId, url, adoptId });
  }
  const background = disposition === "background" || from.profileId !== w.profileId;
  const opened = s.newTab(w.id, { url, adoptId, openerId: from.tabId, profileId: from.profileId, background, gated });
  if (background) noteBackgroundTab(w.id, opened, page.tabId);
  else if (adoptId) noteLinkTabLoad(opened);
}

const opensBehind = (request: OpenWindowRequest) => (request.disposition === "foreground" || request.disposition === "window") && isBlockedPage(request.url);

function keepPopupOpener(page: PageRef) {
  const s = useBrowser.getState();
  const sourceId = peekSourceOf(s, page.tabId);
  if (sourceId) s.peekToTab(page.windowId, { activate: false, sourceId });
}

export function pageProfileId(windowId: string, pageProfile: string): string {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (w && engineProfile(s, w.profileId) === pageProfile) return w.profileId;
  return s.profileOrder.find((p) => engineProfile(s, p) === pageProfile) ?? w?.profileId ?? s.settings.defaultProfileId;
}

export const shiftClickPeeks = (request: Pick<OpenWindowRequest, "shiftClick" | "popup">, peekModifier: string, windowKind: string, fromPeek: boolean) =>
  !!request.shiftClick && !request.popup && peekModifier === "shift" && windowKind === "main" && !fromPeek;
