import { shownPageTone, usePages, type PageState, type PageTone } from "../pages/store";
import { usePullBar } from "./deckPull";
import { useBrowse } from "./store";

export const useDeckOwnsBar = () => usePullBar((s) => s.deckOwns);

export const useSurface = () => useBrowse((s) => s.surface);

export const useSheet = () => useBrowse((s) => s.sheet);

export const useNavigation = <T>(id: string | null, select: (navigation: PageState | null) => T) =>
  usePages((s) => select(id ? s.navigation[id] ?? null : null));

export const usePageTone = (id: string | null): PageTone | null => usePages((s) => (id ? shownPageTone(s, id) : null));

export const useFrozenOrder = () => useBrowse((s) => s.frozenOrder);

export const useOpeningTab = () => useBrowse((s) => s.opening);

export const usePageVeiled = (id: string) => useBrowse((s) => s.veiled === id);

export const usePageCovered = (id: string) => useBrowse((s) => s.covered === id);

export const usePageArriving = (id: string) => useBrowse((s) => s.arriving === id);

export const useLeavingTab = () => useBrowse((s) => s.leaving);

export function watchPageLoad(id: string, show: (progress: number, isLoading: boolean) => void): () => void {
  const read = () => usePages.getState().navigation[id] ?? null;
  let progress = read()?.progress ?? 0;
  let isLoading = read()?.isLoading ?? true;
  show(progress, isLoading);
  return usePages.subscribe((state) => {
    const now = state.navigation[id] ?? null;
    const nextProgress = now?.progress ?? 0;
    const nextLoading = now?.isLoading ?? true;
    if (nextProgress === progress && nextLoading === isLoading) return;
    progress = nextProgress;
    isLoading = nextLoading;
    show(progress, isLoading);
  });
}
