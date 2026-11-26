import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { pluginPageOf } from "./pageNames";

const MAX_KEPT = 6;

export const useKeptPluginPages = create<{ order: string[] }>()(() => ({ order: [] }));

export function keepPluginPage(tabId: string) {
  useKeptPluginPages.setState((k) => {
    if (k.order[k.order.length - 1] === tabId) return k;
    const tabs = useBrowser.getState().tabs;
    return { order: [...k.order.filter((id) => id !== tabId && !!tabs[id] && !!pluginPageOf(tabs[id]!.url)), tabId].slice(-MAX_KEPT) };
  });
}

export const keptPluginPageTabs = (order: readonly string[], s: Pick<ReturnType<typeof useBrowser.getState>, "tabs">, windowId: string) =>
  order.filter((id) => s.tabs[id]?.windowId === windowId && !!pluginPageOf(s.tabs[id]!.url));

export function useKeptPluginPageTabs(windowId: string): string[] {
  const order = useKeptPluginPages((k) => k.order);
  return useBrowser(useShallow((s) => keptPluginPageTabs(order, s, windowId)));
}
