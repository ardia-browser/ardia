import { type LinkRoute, routeLinkTabs } from "../../platform/tabs";
import { showMenu } from "../../platform/menus";
import { focus, openWindow } from "../browser/actions";
import { menuShortcut } from "../commands/commandShortcuts";
import { closeWindowAnimated, isWindowClosing } from "../windows/closeAnimated";
import { routedLinks, type RoutedLinks } from "./linkRoutes";
import { runsJavaScript } from "../settings/scriptUrls";
import { profileAccentOf } from "../spaces/looks";
import { useBrowser } from "../browser/store";
import { confirm } from "../app/system";
import { engineProfileForSpace, activeTabId } from "../browser/model";
import { isSmall, lastActiveSpace, mainWindowFor } from "../windows/small";
import { firstRegular } from "../tabs/openers";
import { navigationOf } from "../tabs/pageSession";
import { asAdoptId } from "../tabs/adoptIds";
import type { AdoptId } from "../browser/types";
import { linkGate, type LinkGateResult, type LinkRouteChoice, type LinkSourceInfo } from "./linkGate";
import { externalLinkOpen, type ExternalLinkOpen } from "./externalLinkOpen";
import { noteExternalLink } from "../telemetry/usage";
import { openInRouteGroup } from "../airTraffic/openAt";
import { noteLittleArdiaAppHandoff, noteLittleArdiaEscapeClose, type EscapePressedIn } from "../telemetry/littleArdiaEscapes";
import { askBeforeQuitting, quitWarningMayAsk } from "../windows/quitWarning";

const store = () => useBrowser.getState();

export function openLittleArdia(url?: string, spaceId?: string, adoptId?: AdoptId, linkPointer?: [number, number], linkApp?: string): string {
  const id = store().createWindow({ kind: "small", url, spaceId, adoptId, linkPointer, linkApp });
  if (!url) store().openPanel(id, "");
  return id;
}


export function openExternalUrls(given: string[], pointer?: [number, number], source?: LinkSourceInfo, returnTo?: string) {
  const settings = store().settings;
  const urls = settings.allowJavaScriptFromAppleEvents ? given : given.filter((url) => !runsJavaScript(url, settings));
  if (!urls.length) return;
  const gate = linkGate();
  const app = returnTo ?? source?.bundleId ?? undefined;
  if (!gate) return openUndecided(urls, pointer, false, app);
  const verdicts = urls.map((url): LinkGateResult | Promise<LinkGateResult> => {
    try {
      return gate(url, source ?? null);
    } catch {
      return { url, route: null, decided: false };
    }
  });
  void Promise.all(verdicts.map((v) => Promise.resolve(v).catch(() => null))).then((results) => {
    const plain: string[] = [];
    results.forEach((result, i) => {
      if (!result) return;
      if (result.route) return openRoutedUrl(result.url, result.route, pointer, app);
      if (result.url !== urls[i]) return openUrlsFromApps([result.url], { spaceId: null, adoptIds: [undefined] }, pointer, true, app);
      plain.push(result.url);
    });
    if (plain.length) openUndecided(plain, pointer, results.some((r) => r?.decided), app);
  });
}

function openRoutedUrl(url: string, route: LinkRouteChoice, pointer?: [number, number], app?: string) {
  const spaceId = route.profileId ?? lastActiveSpace(store());
  if (route.windowId && store().windows[route.windowId]) {
    noteExternalLink("tab", store().settings.openLinksInLittleArdia);
    store().newTab(route.windowId, { url, spaceId, gated: true });
    return focus(route.windowId);
  }
  if (route.groupKey) {
    noteExternalLink("tab", store().settings.openLinksInLittleArdia);
    return openInRouteGroup(url, spaceId, route.groupKey);
  }
  const open = decideExternal([url], route.open);
  if (open === "littleArdia") return void openLittleArdia(url, spaceId, undefined, pointer, app);
  if (open === "window") return focus(openWindow({ url, spaceId }));
  openLinksInMainWindow([url], spaceId, [undefined], true);
}

function decideExternal(urls: string[], ruled: ExternalLinkOpen | null = null): ExternalLinkOpen {
  const on = store().settings.openLinksInLittleArdia;
  const open = externalLinkOpen(on, urls, ruled);
  noteExternalLink(open === "littleArdia" ? "littleArdia" : "tab", on);
  return open;
}

function openUndecided(urls: string[], pointer?: [number, number], gated = false, app?: string) {
  void routeLinkTabs(urls).then(
    (route) => openRoutedUrls(urls, route, pointer, gated, app),
    () => openUrlsFromApps(urls, routedLinks({}, urls.length), pointer, gated, app),
  );
}

function openRoutedUrls(urls: string[], route: LinkRoute, pointer?: [number, number], gated = false, app?: string) {
  const dismissed = new Set(route.dismissed ?? []);
  const kept = urls.map((_, i) => i).filter((i) => !dismissed.has(i));
  if (!kept.length) return;
  const marks = route.adoptIds ?? [];
  openUrlsFromApps(
    kept.map((i) => urls[i]!),
    routedLinks({ ...route, adoptIds: kept.map((i) => marks[i] ?? null) }, kept.length),
    pointer,
    gated,
    app,
  );
}

function openUrlsFromApps(urls: string[], routed: RoutedLinks, pointer?: [number, number], gated = false, app?: string) {
  const [url] = urls;
  const spaceId = routed.spaceId ?? lastActiveSpace(store());
  if (decideExternal(urls) === "littleArdia" && url) return void openLittleArdia(url, spaceId, asAdoptId(routed.adoptIds[0]), pointer, app);
  openLinksInMainWindow(urls, spaceId, routed.adoptIds, gated);
}

function openLinksInMainWindow(urls: string[], spaceId: string, adoptIds: (string | undefined)[], gated = false) {
  let target = mainWindowFor(store(), spaceId);
  urls.forEach((url, i) => {
    const s = store();
    const adoptId = asAdoptId(adoptIds[i]);
    const w = target ? s.windows[target] : undefined;
    const blank = w && w.tabIds.length === 1 ? s.tabs[w.tabIds[0]!] : undefined;
    const panel = w && s.windowUi[w.id]?.panel;
    const barOverBlank = panel?.newTab?.kind === "into" && panel.newTab.tabId === blank?.id;
    const intoBlank = blank && !blank.url && !navigationOf(blank) && blank.spaceId === spaceId && (!panel?.open || barOverBlank);
    if (!w) target = openWindow({ url, spaceId, adoptId });
    else if (intoBlank && !adoptId) s.navigate(blank.id, url, { gated });
    else {
      const index = s.settings.appLinksFirst ? firstRegular(s, w, spaceId) + i : undefined;
      s.newTab(w.id, { url, spaceId, adoptId, gated, index });
      if (intoBlank) store().closeTab(blank.id);
    }
  });
  if (target) focus(target);
}

export function openInMainWindow(windowId: string) {
  const s = store();
  if (!isSmall(s, windowId)) return;
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const target = mainWindowFor(s, tab?.spaceId ?? s.windows[windowId]!.spaceId);
  if (!tab?.url) {
    s.closeWindow(windowId);
    if (target) focus(target);
    else openWindow({ spaceId: tab?.spaceId });
    return;
  }
  const moved = s.moveTabsToWindow([tab.id], target ?? null);
  if (moved) focus(moved);
}

export async function moveLittleArdiaToSpace(windowId: string, spaceId: string) {
  const s = store();
  const w = s.windows[windowId];
  if (!w || !isSmall(s, windowId) || isWindowClosing(windowId) || !s.spaces[spaceId] || w.spaceId === spaceId) return;
  const tabId = activeTabId(s, windowId);
  const url = (tabId ? s.tabs[tabId]?.url : undefined) || undefined;
  const id = store().createWindow({ kind: "small", url, spaceId, frame: w.frame });
  if (!url) store().openPanel(id, "");
  closeWindowAnimated(windowId, {
    replacedBy: id,
    then: () => {
      if (tabId) useBrowser.setState((now) => ({ closedTabs: now.closedTabs.filter((c) => c.tabId !== tabId) }));
    },
  });
}

export function cycleLittleArdiaSpace(windowId: string, delta: 1 | -1) {
  const s = store();
  const w = s.windows[windowId];
  if (!w || s.spaceOrder.length < 2) return;
  const i = s.spaceOrder.indexOf(w.spaceId);
  moveLittleArdiaToSpace(windowId, s.spaceOrder[(i + delta + s.spaceOrder.length) % s.spaceOrder.length]!);
}

export async function openLittleArdiaSpaceMenu(windowId: string) {
  const s = store();
  const current = s.windows[windowId]?.spaceId;
  const choice = await showMenu(
    s.spaceOrder.map((id) => ({
      id,
      title: s.spaces[id]!.name,
      checked: id === current,
      swatch: profileAccentOf(s.spaces[id]),
      ...menuShortcut(`switchSpace:${id}`, s),
    })),
  );
  if (choice) moveLittleArdiaToSpace(windowId, choice);
}

export function closeLittleArdia(windowId: string) {
  if (!isSmall(store(), windowId)) return;
  if (!quitWarningMayAsk()) return closeWindowAnimated(windowId);
  void askBeforeQuitting(windowId).then((answer) => {
    if (answer !== "cancelled" && isSmall(store(), windowId) && !isWindowClosing(windowId)) closeWindowAnimated(windowId);
  });
}

export function closeLittleArdiaForAppLink(windowId: string | null) {
  if (!windowId || !isSmall(store(), windowId) || isWindowClosing(windowId)) return;
  noteLittleArdiaAppHandoff("appLinkClose");
  closeLittleArdia(windowId);
}

export function closeLittleArdiaOnEscape(tabId: string, pressedIn: EscapePressedIn = "page") {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || !isSmall(s, tab.windowId) || isWindowClosing(tab.windowId) || s.find[tabId]?.open || s.windowUi[tab.windowId]?.panel.open) return;
  noteLittleArdiaEscapeClose(pressedIn);
  closeLittleArdia(tab.windowId);
}

export function closeBlankLittleArdiaOnEscape(windowId: string): boolean {
  const s = store();
  if (!isSmall(s, windowId) || isWindowClosing(windowId)) return false;
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (tab && (tab.url || navigationOf(tab))) return false;
  noteLittleArdiaEscapeClose("blankBar");
  closeLittleArdia(windowId);
  return true;
}
