import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { splitSuggestions } from "./suggestions";

export const useDragFallbackPane = (dragging: string | null | undefined, panes: Record<string, unknown>, windowId: string) =>
  useBrowser((s) => {
    if (!dragging || Object.keys(panes).length !== 1 || !panes[dragging]) return null;
    const tab = s.tabs[dragging];
    const others = (s.windows[windowId]?.tabIds ?? []).map((id) => s.tabs[id]!).filter((t) => t && t.id !== dragging && t.profileId === tab?.profileId);
    return others.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;
  });

export const useSplitSuggestions = (tabId: string, text: string) => useBrowser(useShallow((s) => splitSuggestions(s, tabId, text)));
