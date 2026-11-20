import { discardOffered, type OpenWindowRequest } from "../../platform/tabs";
import { openWindow } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { engineProfile, engineProfileForSpace } from "../browser/model";
import { peekSourceOf } from "../peek/peek";
import { leavesSite, newTabLinkRoute, siteLanding } from "../peek/newTabLinkRoute";
import { openLittleArdia } from "../littleArdia/actions";
import { isSmall, originalSpace, privateWindowSpace } from "../windows/small";
import { openLinkInSplit, openSplitPane } from "../splits/actions";
import { asAdoptId, isAdoptKind } from "./adoptIds";
import { gateOpening, isGatedUrl, settleOpening } from "./openingGate";
import { noteBackgroundTab } from "./newTabNotice";
import { noteBlockedPageBehind, noteLinkTabWait } from "../telemetry/usage";
import { isBlockedPage } from "../site/contentBlocking";
import { notePeekFromShiftWindow, notePopupOpenedAsTab } from "../telemetry/popupTabCounts";
import { noteLinkTabLoad } from "../telemetry/barLoadFocus";

export type { OpenWindowRequest } from "../../platform/tabs";

type PageRef = { windowId: string; spaceId: string; tabId?: string };

const UNGATED = new Set(["current", "peek", "incognito"]);

export function openFromPage(request: OpenWindowRequest, page: PageRef) {
  if (request.linkWait) noteLinkTabWait(request.linkWait);
  if (UNGATED.has(request.disposition) || !isGatedUrl(request.url)) return openNow(request, page, false);
  const gated = gateOpening(request.url, { tabId: page.tabId ?? null, windowId: page.windowId, profileId: page.spaceId, via: "link" }, null);
  settleOpening(gated, null, (verdict) => {
    if (verdict && "cancel" in verdict) {
      if (request.adoptId) void discardOffered(request.adoptId).catch(() => false);
      return;
    }
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
  const { url, profile: space, point } = request;
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
    return void s.newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background: true, gated });
  }
  if (disposition === "foreground" && request.fromClick && isAdoptKind(adoptId, "ardiacore") && page.tabId) {
    const route = newTabLinkRoute(s, page.tabId, url);
    if (route === "peek") return void s.openPeek(page.tabId, url, point ?? null, { adoptId });
    if (route === "otherSite") return void s.openPeek(page.tabId, url, point ?? null, { adoptId, landing: siteLanding(s.tabs[page.tabId]!.url, "tab") });
    if (route === "littleArdia") return void openLittleArdia(url, from.spaceId, adoptId);
  }
  if (disposition === "split") {
    if (from.tabId) return openLinkInSplit(from.tabId, url, adoptId);
    openSplitPane(w.id, { url, adoptId });
    return;
  }
  if (disposition === "incognito") {
    const spaceId = privateWindowSpace(s, w, space);
    const incognitoEngineId = (w.kind === "private") ? w.incognitoEngineId : undefined;
    if (isAdoptKind(adoptId, "tab")) return void openWindow({ kind: "private", url, adoptId, spaceId, incognitoEngineId });
    return void openWindow({ kind: "private", url, spaceId, incognitoEngineId });
  }
  if (disposition === "window") {
    return void openWindow((w.kind === "private") ? { kind: "private", url, spaceId: originalSpace(s, w), incognitoEngineId: w.incognitoEngineId } : { spaceId: from.spaceId, url, adoptId });
  }
  const background = disposition === "background" || from.spaceId !== w.spaceId;
  const opened = s.newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background, gated });
  if (background) noteBackgroundTab(w.id, opened, page.tabId);
  else if (adoptId) noteLinkTabLoad(opened);
}

const opensBehind = (request: OpenWindowRequest) => (request.disposition === "foreground" || request.disposition === "window") && isBlockedPage(request.url);

function keepPopupOpener(page: PageRef) {
  const s = useBrowser.getState();
  const sourceId = peekSourceOf(s, page.tabId);
  if (sourceId) s.peekToTab(page.windowId, { activate: false, sourceId });
}

export function pageSpaceId(windowId: string, pageSpace: string): string {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (w && engineProfile(s, w.spaceId) === pageSpace) return w.spaceId;
  return s.spaceOrder.find((p) => engineProfile(s, p) === pageSpace) ?? w?.spaceId ?? s.settings.defaultSpaceId;
}

export const shiftClickPeeks = (request: Pick<OpenWindowRequest, "shiftClick" | "popup">, peekModifier: string, windowKind: string, fromPeek: boolean) =>
  !!request.shiftClick && !request.popup && peekModifier === "shift" && windowKind === "main" && !fromPeek;
