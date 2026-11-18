import { useBrowser } from "../browser/store";
import { historyOf, NO_HISTORY, suggestionHistoryOf } from "./history";

export const useSpaceHistory = (spaceId: string | null) => useBrowser((s) => (spaceId === null ? NO_HISTORY : historyOf(s, spaceId)));

export const useSuggestionHistory = (profileId: string | null) => useBrowser((s) => (profileId === null ? NO_HISTORY : suggestionHistoryOf(s, profileId)));

export const useWindowHistory = (windowId: string | null) =>
  useBrowser((s) => {
    const w = windowId ? s.windows[windowId] : undefined;
    return w ? historyOf(s, w.spaceId) : undefined;
  });
