import { useShallow } from "zustand/react/shallow";
import { keyedWatch, useKeyed } from "../browser/keyedWatch";
import { useBrowser, type BrowserState } from "../browser/store";
import { splitOf, splitTabIds, splitTabIdsOf } from "./splits";

const watchSplits = keyedWatch<BrowserState>(() => useBrowser, (s, prev) => (s.splits !== prev.splits ? true : undefined));

export const useSplitOrientation = (tabId: string | undefined) =>
  useKeyed(watchSplits, tabId, () => splitOf(useBrowser.getState(), tabId)?.orientation ?? null);

export const useDragFallbackPane = (dragging: string | null | undefined, panes: Record<string, unknown>, windowId: string) =>
  useBrowser((s) => {
    if (!dragging || Object.keys(panes).length !== 1 || !panes[dragging]) return null;
    const tab = s.tabs[dragging];
    const others = (s.windows[windowId]?.tabIds ?? []).map((id) => s.tabs[id]!).filter((t) => t && t.id !== dragging && t.profileId === tab?.profileId);
    return others.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;
  });

export const useSplitSuggestions = (tabId: string) =>
  useBrowser(
    useShallow((s) => {
      const tab = s.tabs[tabId];
      const w = tab && s.windows[tab.windowId];
      if (!w) return [];
      const inSplit = new Set(splitTabIdsOf(Object.values(s.splits).find((v) => splitTabIds(v).includes(tabId))) ?? [tabId]);
      return w.tabIds
        .map((id) => s.tabs[id]!)
        .filter((t) => t && t.url && t.profileId === tab.profileId && !inSplit.has(t.id))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 5)
        .map((t) => t.id);
    }),
  );

export const useSplitPaneIds = (tabId: string) =>
  useBrowser(useShallow((s) => splitTabIdsOf(Object.values(s.splits).find((v) => splitTabIds(v).includes(tabId))) ?? [tabId]));
