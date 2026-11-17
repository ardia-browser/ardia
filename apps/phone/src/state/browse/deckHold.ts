import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { create, type StoreApi } from "zustand";
import { useRootSize, type RootSize } from "../app/rootSize";
import { shownPageTone, usePages, type PageTone } from "../pages/store";
import { useSearch } from "../search/store";
import { tabsInSpace } from "../tabs/spaces";
import { useTabs } from "../tabs/store";
import { recencyOrder, type BrowserTab } from "../tabs/tabModels";
import { useBrowse } from "./store";

const useDeckRefresh = create<{ round: number }>()(() => ({ round: 0 }));

export const refreshHiddenDeck = () => useDeckRefresh.setState((state) => ({ round: state.round + 1 }));

export const deckIsShown = () => useBrowse.getState().surface === "deck";

const sameItems = <T extends readonly unknown[]>(a: T, b: T) => a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

export function useHeldWhileDeckHidden<S, T>(store: StoreApi<S>, select: (state: S) => T, same: (a: T, b: T) => boolean = Object.is): T {
  const held = useRef<{ value: T; round: number } | null>(null);
  const subscribe = useCallback(
    (changed: () => void) => {
      const stops = [store.subscribe(changed), useBrowse.subscribe(changed), useDeckRefresh.subscribe(changed)];
      return () => stops.forEach((stop) => stop());
    },
    [store],
  );
  const snapshot = () => {
    const round = useDeckRefresh.getState().round;
    const now = held.current;
    if (now && now.round === round && !deckIsShown()) return now.value;
    const value = select(store.getState());
    if (now && same(now.value, value)) {
      now.round = round;
      return now.value;
    }
    held.current = { value, round };
    return value;
  };
  return useSyncExternalStore(subscribe, snapshot);
}

export function useHeldDeckOrder(): { tabs: BrowserTab[]; selectedId: string | null } {
  const [open, privates, selectedId, spaces] = useHeldWhileDeckHidden(useTabs, (s) => [s.open, s.privates, s.selectedId, s.spaces] as const, sameItems);
  const tabs = useMemo(() => recencyOrder([...tabsInSpace(open, spaces), ...privates], selectedId), [open, privates, selectedId, spaces]);
  return { tabs, selectedId };
}

export const useHeldPageTone = (id: string): PageTone | null => useHeldWhileDeckHidden(usePages, (s) => shownPageTone(s, id));

export const useHeldSearchOpen = () => useHeldWhileDeckHidden(useSearch, (s) => s.open);

export const useHeldRootSize = (): RootSize => useHeldWhileDeckHidden(useRootSize, (s) => s);
