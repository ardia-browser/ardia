import { useShallow } from "zustand/react/shallow";
import { useToolbarHeld } from "../app/transientUi";
import { useFindOpen } from "../browser/hooks";
import { keyedWatch, useKeyed } from "../browser/keyedWatch";
import { useBrowser, type BrowserState } from "../browser/store";
import { useEngineOffers } from "../engines/actions";
import { useCast } from "../media/cast";
import { useMedia } from "../media/media";
import { useDeviceChooserOpen } from "../site/deviceChoosers";
import { usePages } from "../tabs/pageState";
import { useHistoryMenu } from "../tabs/navigation";
import { useToolbarAutoHide } from "../windows/toolbarAutoHide";
import { splitOf, splitTabIds, splitTabIdsOf } from "./splits";

const watchSplits = keyedWatch<BrowserState>(() => useBrowser, (s, prev) => (s.splits !== prev.splits ? true : undefined));

export const useSplitOrientation = (tabId: string | undefined) =>
  useKeyed(watchSplits, tabId, () => splitOf(useBrowser.getState(), tabId)?.orientation ?? null);

export const useSplitForTab = (tabId: string | undefined) =>
  useKeyed(watchSplits, tabId, () => splitOf(useBrowser.getState(), tabId) ?? null);

export const usePaneToolbarCollapsed = (windowId: string, tabId: string, autoHide: boolean) => {
  const down = useToolbarAutoHide((s) => autoHide && !!s.scrolledDown[tabId] && !s.peek[tabId]);
  const held = useToolbarHeld(windowId, tabId, down);
  return down && !held;
};

export const usePaneTopLeftObscured = (tabId: string) => {
  const page = usePages((s) => {
    const p = s.pages[tabId];
    return !!s.popover[tabId] || !!p?.permission || !!p?.externalApp || !!p?.crashed || !!p?.unresponsive || !!(p?.status && p.statusAtTop);
  });
  const history = useHistoryMenu((s) => s.menu?.tabId === tabId);
  const find = useFindOpen(tabId);
  const engineOffer = useEngineOffers((offers) => !!offers[tabId]);
  const deviceChooser = useDeviceChooserOpen(tabId);
  const sharePicker = useMedia((m) => !!m.displayRequests[tabId]);
  const castPicker = useCast((c) => !!c.dialogs[tabId]);
  return page || history || find || engineOffer || deviceChooser || sharePicker || castPicker;
};

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
