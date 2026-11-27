import { useBrowser } from "../browser/store";
import { changedIds } from "../browser/changes";
import type { AppHistory, Tab, TabLive } from "../browser/types";
import { isAppPage, tabDestination } from "../pages/urls";
import { adoptedPage, hasPage, loadedPage } from "./pageSession";
import { pendingRestore, segmentId } from "./adoptIds";
import { appHistoryStep, currentAppEntry, keptAt, movedTo, pushedEntry, takenKept, withCurrentEntry, withoutForward } from "./appHistory";

const store = () => useBrowser.getState();
const TRAVERSAL_MS = 5000;
const traversals = new Map<string, number>();

const noteTraversal = (tabId: string) => void traversals.set(tabId, Date.now() + TRAVERSAL_MS);

function tookTraversal(tabId: string): boolean {
  const until = traversals.get(tabId);
  if (until === undefined) return false;
  traversals.delete(tabId);
  return until >= Date.now();
}

export const noteWebTraversal = noteTraversal;

export const showsAppPage = (t: Pick<Tab, "url" | "page"> | undefined) => !!t && isAppPage(tabDestination(t));

export function appStep(t: Tab | undefined, live: Pick<TabLive, "canGoBack" | "canGoForward">, direction: -1 | 1): number | null {
  const step = appHistoryStep(t?.appHistory, direction);
  if (step === null || showsAppPage(t)) return step;
  return (direction < 0 ? live.canGoBack : live.canGoForward) ? null : step;
}

function keptKeyOf(id: string, t: Tab): string | null {
  if (hasPage(t)) return id;
  return pendingRestore(t) ?? null;
}

function leavingWeb(id: string, t: Tab, h: AppHistory | undefined): AppHistory {
  const web = { url: t.url || tabDestination(t), title: t.title };
  const current = currentAppEntry({ appHistory: h });
  const base = current && !isAppPage(current.url) ? withCurrentEntry(h!, web) : pushedEntry(h, web);
  const key = keptKeyOf(id, t);
  return key ? keptAt(base, base.index, key) : takenKept(base);
}

export function followedAppHistory(id: string, tab: Tab, before: Tab): AppHistory | undefined {
  const to = tabDestination(tab);
  const from = tabDestination(before);
  const seeded = !tab.appHistory && from !== to && isAppPage(from) ? pushedEntry(undefined, { url: from, title: before.title }) : undefined;
  const h = tab.appHistory ?? seeded;
  const current = currentAppEntry({ appHistory: h });
  if (to === from) {
    if (h && current && tab.url === current.url && tab.title && tab.title !== current.title) return withCurrentEntry(h, { title: tab.title });
    return h;
  }
  if (!to) return h;
  const toApp = isAppPage(to);
  if (!h && !toApp) return h;
  if (current?.url === to) return h;
  if (!from && h) return toApp ? pushedEntry(undefined, { url: to, title: "" }) : undefined;
  if (toApp) {
    const base = from && !isAppPage(from) ? leavingWeb(id, before, h) : h;
    return pushedEntry(base, { url: to, title: "" });
  }
  if (!current || isAppPage(current.url)) return pushedEntry(h, { url: to, title: tab.title });
  const moved = withCurrentEntry(h!, { url: to, title: tab.title });
  return tookTraversal(id) ? moved : withoutForward(moved);
}

let watching = false;

export function watchAppPageHistory() {
  if (watching) return;
  watching = true;
  useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs === prev.tabs) return;
    for (const id of traversals.keys()) if (!s.tabs[id]) traversals.delete(id);
    for (const id of changedIds(s.tabs, prev.tabs)) {
      const tab = s.tabs[id];
      const before = prev.tabs[id];
      if (!tab || !before || (!tab.appHistory && !showsAppPage(tab) && !showsAppPage(before))) continue;
      const next = followedAppHistory(id, tab, before);
      const unadopted = tab.page.kind === "adopted" && tab.page.nav && showsAppPage(tab) ? loadedPage(tab.page.nav) : null;
      if (next !== tab.appHistory || unadopted) store().updateTab(id, { appHistory: next, ...(unadopted ? { page: unadopted } : {}) });
    }
  });
}

export function goToAppEntry(tabId: string, index: number): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  const h = tab?.appHistory;
  const entry = h?.entries[index];
  if (!tab || !h || !entry || index === h.index) return false;
  const shown = tabDestination(tab);
  const from = shown && !isAppPage(shown) ? leavingWeb(tabId, tab, h) : h;
  const next = movedTo(from, index);
  if (isAppPage(entry.url)) {
    s.updateTab(tabId, { appHistory: next });
    s.navigate(tabId, entry.url, { userInitiated: false });
    return true;
  }
  noteTraversal(tabId);
  if (next.kept?.index === index) {
    s.updateTab(tabId, { appHistory: takenKept(next), url: entry.url, title: entry.title, favicon: null, page: adoptedPage(segmentId(next.kept.key)) });
    return true;
  }
  s.updateTab(tabId, { appHistory: next });
  s.navigate(tabId, entry.url, { userInitiated: false });
  return true;
}

export function routeAppPage(tabId: string, url: string, replace: boolean): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || !showsAppPage(tab)) return false;
  const h = tab.appHistory;
  const current = currentAppEntry(tab);
  if (current?.url === url) return false;
  const next = pushedEntry(h && current ? h : pushedEntry(undefined, { url: tabDestination(tab), title: tab.title }), { url, title: replace ? (current?.title ?? "") : "" }, replace);
  s.updateTab(tabId, { appHistory: next });
  s.navigate(tabId, url, { userInitiated: false });
  return true;
}
