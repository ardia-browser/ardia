import { create } from "zustand";
import { goBackAcrossEngines } from "../engines/actions";
import { confirm } from "../../platform/dialogs";
import { livePageId, withLivePage } from "./livePage";
import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { changedIds } from "../browser/changes";
import { activeTabId, inPinnedContainer } from "../browser/model";
import { noteBackCloseToOpener } from "../telemetry/usage";
import { useTab, useTabLive } from "../browser/hooks";
import { useBrowserWhile } from "./tabWatch";
import type { TabLive } from "../browser/types";
import { isAppPage, tabDestination } from "../pages/urls";
import { pageOf, patchPage, usePage } from "./pageState";
import { historyOf } from "../history/history";
import { adoptedPage, IDLE } from "./pageSession";
import { isPeekTab } from "../peek/peek";
import { dismissPeek } from "../peek/actions";
import { liveOf } from "./tabLive";
import { appStep, goToAppEntry, noteWebTraversal, showsAppPage, watchAppPageHistory } from "./appPageHistory";
import { appHistoryStep } from "./appHistory";

watchAppPageHistory();

const store = () => useBrowser.getState();

function backClosesTab(s: BrowserState, tabId: string): boolean {
  const tab = s.tabs[tabId];
  if (!tab?.openerId) return false;
  if (!isPeekTab(s, tabId) && tab.linkOpenerId !== tab.openerId) return false;
  const opener = s.tabs[tab.openerId];
  if (!opener || opener.windowId !== tab.windowId || opener.profileId !== tab.profileId) return false;
  if (inPinnedContainer(s, tabId)) return false;
  return true;
}

export function canGoBack(tabId: string, live: Pick<TabLive, "canGoBack">, s: BrowserState = store()): boolean {
  const page = pageOf(tabId);
  return !page.newTabShown && (live.canGoBack || appHistoryStep(s.tabs[tabId]?.appHistory, -1) !== null || page.backToNewTab || !!page.engineBack || backClosesTab(s, tabId));
}

export function canGoForward(tabId: string, live: Pick<TabLive, "canGoForward">, s: BrowserState = store()): boolean {
  return !!pageOf(tabId).newTabShown || live.canGoForward || appHistoryStep(s.tabs[tabId]?.appHistory, 1) !== null;
}

const appMoves = (t: { appHistory?: Parameters<typeof appHistoryStep>[0] } | undefined) => (appHistoryStep(t?.appHistory, -1) !== null ? 1 : 0) | (appHistoryStep(t?.appHistory, 1) !== null ? 2 : 0);

export function useHistoryAvailability(tabId: string) {
  const moves = useTabLive(tabId, (l) => (l.canGoBack ? 1 : 0) | (l.canGoForward ? 2 : 0));
  const back = !!(moves & 1);
  const forward = !!(moves & 2);
  const shown = usePage(tabId, (p) => !!p.newTabShown);
  const backToNewTab = usePage(tabId, (p) => p.backToNewTab || !!p.engineBack);
  const opened = useTab(tabId, (t) => !!t?.openerId);
  const app = useTab(tabId, appMoves);
  const appBack = !!(app & 1);
  const closes = useBrowserWhile(opened, (s) => opened && backClosesTab(s, tabId));
  return { back: !shown && (back || appBack || backToNewTab || closes), forward: shown || forward || !!(app & 2), backCloses: !shown && !back && !appBack && !backToNewTab && closes };
}

export function goBack(tabId: string, mayAct: () => boolean = () => true): void {
  void goBackAsking(tabId, mayAct);
}

export async function goBackAsking(tabId: string, mayAct: () => boolean = () => true, ask: typeof confirm = confirm): Promise<boolean> {
  if (livePageId(tabId) !== tabId) {
    let went: Promise<boolean> = Promise.resolve(false);
    const acted = await withLivePage(tabId, (_, id) => (went = goBackAsking(id, mayAct, ask)), mayAct);
    return acted ? went : false;
  }
  if (pageOf(tabId).newTabShown) return true;
  if (pageOf(tabId).engineBack && !liveOf(tabId).canGoBack && !showsAppPage(store().tabs[tabId])) return goBackAcrossEngines(tabId, mayAct, ask);
  goBackHere(tabId);
  return true;
}

function goBackHere(tabId: string) {
  const tab = store().tabs[tabId];
  if (liveOf(tabId).canGoBack && !showsAppPage(tab)) {
    if (tab?.appHistory) noteWebTraversal(tabId);
    return void webviews.get(tabId)?.goBack();
  }
  const step = appStep(tab, liveOf(tabId), -1);
  if (step !== null) return void goToAppEntry(tabId, step);
  if (pageOf(tabId).backToNewTab) return showNewTab(tabId);
  if (backClosesTab(store(), tabId)) {
    noteBackCloseToOpener();
    if (isPeekTab(store(), tabId)) dismissPeek(store().tabs[tabId]!.windowId);
    else {
      const tab = store().tabs[tabId]!;
      const openerId = tab.openerId!;
      const wasShown = activeTabId(store(), tab.windowId) === tabId;
      store().closeTab(tabId);
      if (wasShown && store().tabs[openerId]) store().activate(openerId);
    }
  }
}

export function goForward(tabId: string, mayAct: () => boolean = () => true): void {
  void goForwardAsking(tabId, mayAct);
}

export async function goForwardAsking(tabId: string, mayAct: () => boolean = () => true): Promise<boolean> {
  if (livePageId(tabId) === tabId) return goForwardHere(tabId);
  let went = false;
  const acted = await withLivePage(tabId, (_, id) => (went = goForwardHere(id)), mayAct);
  return acted && went;
}

function goForwardHere(tabId: string): boolean {
  if (pageOf(tabId).newTabShown) {
    hideNewTab(tabId);
    return true;
  }
  const tab = store().tabs[tabId];
  const step = appStep(tab, liveOf(tabId), 1);
  if (step !== null) return goToAppEntry(tabId, step);
  const page = webviews.get(tabId);
  if (!page || showsAppPage(tab)) return false;
  if (tab?.appHistory) noteWebTraversal(tabId);
  void page.goForward();
  return true;
}

function showNewTab(tabId: string, keep?: { url: string; title: string }) {
  const tab = store().tabs[tabId];
  if (!tab?.url) return;
  patchPage(tabId, { newTabShown: { url: keep?.url ?? tab.url, title: keep?.title ?? tab.title, favicon: tab.favicon }, status: "" });
  const internal = isAppPage(tabDestination(tab));
  const page = internal && tab.page.kind === "loaded" ? IDLE : internal && tab.page.kind === "adopted" ? adoptedPage(tab.page.adopt) : tab.page;
  store().updateTab(tabId, { url: "", title: "", favicon: null, page });
}

function goBackToNewTab(tabId: string, offset: number, first: { url: string; title: string }) {
  if (!pageOf(tabId).backToNewTab || pageOf(tabId).newTabShown) return;
  if (offset) void webviews.get(tabId)?.goToOffset(offset);
  showNewTab(tabId, offset ? first : undefined);
}

function hideNewTab(tabId: string) {
  const kept = pageOf(tabId).newTabShown;
  if (!kept) return;
  patchPage(tabId, { newTabShown: null });
  store().updateTab(tabId, { url: kept.url, title: kept.title, favicon: kept.favicon });
}

useBrowser.subscribeTo(["tabs"], (s, prev) => {
  for (const id of changedIds(s.tabs, prev.tabs)) {
    const tab = s.tabs[id];
    const before = prev.tabs[id];
    if (!tab || !before) continue;
    if (!tabDestination(before) && isAppPage(tabDestination(tab)) && !pageOf(id).backToNewTab) patchPage(id, { backToNewTab: true });
  }
});

export type HistoryItem = {
  key: string;
  title: string;
  url: string;
  offset: number | "newTab" | { app: number };
};

function appItems(tabId: string, direction: -1 | 1, max: number): HistoryItem[] {
  const h = store().tabs[tabId]?.appHistory;
  const items: HistoryItem[] = [];
  if (!h) return items;
  for (let i = h.index + direction; i >= 0 && i < h.entries.length && items.length < max; i += direction) {
    const e = h.entries[i]!;
    items.push({ key: `app:${i}`, title: e.title || e.url, url: e.url, offset: { app: i } });
  }
  return items;
}

export async function historyItems(asked: string, direction: -1 | 1, max = 15): Promise<HistoryItem[]> {
  const tabId = livePageId(asked);
  const page = pageOf(tabId);
  const onApp = showsAppPage(store().tabs[tabId]);
  const list = (onApp ? null : await webviews.get(tabId)?.navigationEntries()) ?? [];
  const current = list.findIndex((e) => e.current);
  if (page.newTabShown) {
    if (direction < 0) return [];
    const items: HistoryItem[] = [];
    for (let i = Math.max(current, 0); i < list.length && items.length < max; i++) {
      const e = list[i]!;
      items.push({ key: String(i), title: e.title || e.url, url: e.url, offset: i - current });
    }
    if (!items.length) items.push({ key: "kept", title: page.newTabShown.title || page.newTabShown.url, url: page.newTabShown.url, offset: 0 });
    return items;
  }
  const items: HistoryItem[] = [];
  if (current >= 0) {
    for (let i = current + direction; i >= 0 && i < list.length && items.length < max; i += direction) {
      const e = list[i]!;
      items.push({ key: String(i), title: e.title || e.url, url: e.url, offset: i - current });
    }
  }
  items.push(...appItems(tabId, direction, max - items.length));
  if (direction < 0 && page.backToNewTab && items.length < max) items.push({ key: "newTab", title: "New Tab", url: "", offset: "newTab" });
  return items;
}

export async function goToHistoryItem(tabId: string, item: HistoryItem): Promise<void> {
  if (livePageId(tabId) !== tabId) return void (await withLivePage(tabId, (_, id) => void goToHistoryItem(id, item)));
  const page = pageOf(tabId);
  if (typeof item.offset === "object") {
    if (page.newTabShown) hideNewTab(tabId);
    return void goToAppEntry(tabId, item.offset.app);
  }
  if (item.offset === "newTab") {
    const shown = store().tabs[tabId];
    const first = shown?.appHistory?.entries[0];
    if (showsAppPage(shown) && first && shown!.appHistory!.index > 0) {
      goToAppEntry(tabId, 0);
      return showNewTab(tabId, first);
    }
    const list = (await webviews.get(tabId)?.navigationEntries()) ?? [];
    const current = list.findIndex((e) => e.current);
    if (current <= 0 || !list[0]) return goBack(tabId);
    return goBackToNewTab(tabId, -current, list[0]);
  }
  if (page.newTabShown) {
    hideNewTab(tabId);
    if (item.offset) void webviews.get(tabId)?.goToOffset(item.offset);
    return;
  }
  if (item.offset === -1) return goBack(tabId);
  if (item.offset === 1) return goForward(tabId);
  if (item.offset) void webviews.get(tabId)?.goToOffset(item.offset);
}

type HistoryMenu = { tabId: string; direction: -1 | 1; items: HistoryItem[] };
export const useHistoryMenu = create<{ menu: HistoryMenu | null }>()(() => ({ menu: null }));

export async function openHistoryMenu(tabId: string, direction: -1 | 1) {
  const items = await historyItems(tabId, direction);
  if (!items.length) return;
  useHistoryMenu.setState({ menu: { tabId, direction, items } });
}

export const closeHistoryMenu = () => useHistoryMenu.setState({ menu: null });

export const closeHistoryMenuOf = (tabId: string) => {
  if (useHistoryMenu.getState().menu?.tabId === tabId) closeHistoryMenu();
};

export function historyFavicons(profileId: string, items: readonly { url: string }[]): Map<string, string | null> {
  const urls = new Set(items.map((i) => i.url));
  return new Map(historyOf(useBrowser.getState(), profileId).filter((h) => urls.has(h.url)).map((h) => [h.url, h.favicon]));
}

export function toggleHistoryMenu(tabId: string, direction: -1 | 1) {
  const open = useHistoryMenu.getState().menu;
  if (open?.tabId === tabId && open.direction === direction) return closeHistoryMenu();
  void openHistoryMenu(tabId, direction);
}
