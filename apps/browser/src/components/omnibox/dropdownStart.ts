import { tabTitle } from "../../state/browser/model";
import { recentTabSuggestions, type Suggestion } from "@ardia/core";
import { useMemo } from "react";
import { useSettings, useTab, useWindow } from "../../state/browser/hooks";
import { useSuggestionHistory } from "../../state/history/hooks";
import { usePeeks } from "../../state/peek/hooks";
import { useTabs } from "../../state/tabs/hooks";
import { openTabsByUse } from "../../state/tabs/tabShare";
import { withoutFragment } from "../../lib/url";
import { commandBarTabLimit, keepsOpenTab } from "../../state/omnibox/commandBarStart";

const RECENT = 4;

type Visited = { url: string; lastVisit: number };

export function recentPages<H extends Visited>(history: readonly H[], shownUrl: string, count: number): H[] {
  const shown = shownUrl ? withoutFragment(shownUrl) : null;
  const top: { key: string; row: H }[] = [];
  for (const row of history) {
    if (top.length === count && row.lastVisit <= top[count - 1]!.row.lastVisit) continue;
    const key = withoutFragment(row.url);
    if (key === shown) continue;
    const same = top.findIndex((t) => t.key === key);
    if (same >= 0) {
      if (row.lastVisit <= top[same]!.row.lastVisit) continue;
      top.splice(same, 1);
    }
    let at = top.length;
    while (at > 0 && top[at - 1]!.row.lastVisit < row.lastVisit) at--;
    top.splice(at, 0, { key, row });
    if (top.length > count) top.pop();
  }
  return top.map((t) => t.row);
}

export function useDropdownStart(enabled: boolean, tabId: string, profileId: string): Suggestion[] {
  const url = useTab(tabId, (t) => (enabled ? (t?.url ?? "") : ""));
  const title = useTab(tabId, (t) => (enabled ? (t?.title ?? "") : ""));
  const favicon = useTab(tabId, (t) => (enabled ? (t?.favicon ?? null) : null));
  const historyOn = useSettings((st) => st.commandBarHistory);
  const history = useSuggestionHistory(enabled && historyOn ? profileId : null);
  const recent = useMemo(() => recentPages(history, url, RECENT).map((h): Suggestion => ({ kind: "page", url: h.url, title: h.title, favicon: h.favicon, visited: true })), [history, url]);
  return useMemo(() => (url ? [{ kind: "page" as const, url, title, favicon }, ...recent] : recent), [url, title, favicon, recent]);
}

const NO_TABS: Suggestion[] = [];

export function useOpenTabsStart(enabled: boolean, windowId: string, profileId: string): Suggestion[] {
  const tabs = useTabs((all) => (enabled ? all : null));
  const peeks = usePeeks((all) => (enabled ? all : null));
  const shared = useSettings((st) => !!st.shareTabsAcrossWindows);
  const start = useSettings((st) => st.commandBarStart);
  const active = useWindow(windowId, (w) => (enabled ? w?.activeTabIds[profileId] : undefined));
  return useMemo(() => {
    if (!tabs || !peeks) return NO_TABS;
    const limit = commandBarTabLimit(start);
    if (limit === 0) return NO_TABS;
    const rows = openTabsByUse(tabs, peeks, { profileId, windowId, shared })
      .filter(({ tab: t }) => keepsOpenTab(start, t.pin))
      .map(({ tab: t, lastActiveAt }) => ({ id: t.id, url: t.url, title: tabTitle(t), favicon: t.favicon, lastActiveAt }));
    return recentTabSuggestions(rows, { exclude: active, limit });
  }, [tabs, peeks, active, profileId, shared, windowId, start]);
}
