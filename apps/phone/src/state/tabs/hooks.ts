import { useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { recencyOrder, type BrowserTab } from "./tabModels";
import { isSplit, tabsInSpace } from "./spaces";
import { archiveDays, findTab, selectedTab, type ArchivedDay } from "./tabsState";
import { useTabs } from "./store";

export const useSelectedTabId = () => useTabs((s) => s.selectedId);

export const useSelectedTab = () =>
  useTabs((s) => (s.selectedId === null ? null : s.open.find((t) => t.id === s.selectedId) ?? s.privates.find((t) => t.id === s.selectedId) ?? null));

export const useShownTabId = () => useTabs((s) => (s.selectedId !== null && (s.open.some((t) => t.id === s.selectedId) || s.privates.some((t) => t.id === s.selectedId)) ? s.selectedId : null));

export const sameChrome = (a: BrowserTab, b: BrowserTab) =>
  a.id === b.id && a.url === b.url && a.title === b.title && a.faviconUrl === b.faviconUrl && a.themeColorHex === b.themeColorHex && a.isPrivate === b.isPrivate && a.profileSyncId === b.profileSyncId && a.pinnedKey === b.pinnedKey;

function useHeld<T>(select: (state: ReturnType<typeof useTabs.getState>) => T, same: (a: T, b: T) => boolean): T {
  const held = useRef<{ value: T } | null>(null);
  return useTabs((state) => {
    const next = select(state);
    const was = held.current;
    if (was && same(was.value, next)) return was.value;
    held.current = { value: next };
    return next;
  });
}

export const useChromeTab = (id: string): BrowserTab | null =>
  useHeld(
    (s) => s.open.find((t) => t.id === id) ?? s.privates.find((t) => t.id === id) ?? null,
    (a, b) => a === b || (a !== null && b !== null && sameChrome(a, b)),
  );

export const useTabWhile = (id: string, wanted: boolean): BrowserTab | null => useTabs((s) => (wanted ? (findTab(s, id) ?? null) : null));

export function sameBarOrder(a: readonly BrowserTab[], b: readonly BrowserTab[]) {
  if (a.length !== b.length) return false;
  const stackedBehindFront = a.length - 2;
  return a.every((tab, at) => {
    const other = b[at]!;
    if (tab === other) return true;
    if (tab.id !== other.id || tab.title !== other.title || tab.url !== other.url || tab.isPrivate !== other.isPrivate || tab.faviconUrl !== other.faviconUrl) return false;
    return at !== stackedBehindFront || tab.snapshotFileName === other.snapshotFileName;
  });
}

export const useBarOrder = (isPrivate: boolean | null): BrowserTab[] =>
  useHeld((s) => {
    const order = recencyOrder([...tabsInSpace(s.open, s.spaces), ...s.privates], s.selectedId);
    return isPrivate === null ? order : order.filter((tab) => tab.isPrivate === isPrivate);
  }, sameBarOrder);

export const useSwipeIds = (isPrivate: boolean | null): string[] =>
  useHeld(
    (s) => recencyOrder([...tabsInSpace(s.open, s.spaces), ...s.privates], s.selectedId).filter((tab) => isPrivate === null || tab.isPrivate === isPrivate).map((tab) => tab.id),
    (a, b) => a.length === b.length && a.every((id, at) => id === b[at]),
  );

export const useTab = (id: string) => useTabs((s) => s.open.find((t) => t.id === id) ?? s.privates.find((t) => t.id === id) ?? null);

export function useDeckOrder(): BrowserTab[] {
  const [open, privates, selectedId, spaces] = useTabs(useShallow((s) => [s.open, s.privates, s.selectedId, s.spaces] as const));
  return useMemo(() => recencyOrder([...tabsInSpace(open, spaces), ...privates], selectedId), [open, privates, selectedId, spaces]);
}

export const useShownSpace = () => useTabs((s) => (isSplit(s.spaces) ? s.spaces.current : null));

export const useTabSpaces = () => useTabs((s) => s.spaces);

export const useHasTabs = () => useTabs((s) => s.open.length + s.privates.length > 0);

export const usePrivateCount = () => useTabs((s) => s.privates.length);

export const useIncognito = () => useTabs((s) => s.incognito);

export const useBrowsingPrivately = () => useTabs((s) => s.incognito || selectedTab(s)?.isPrivate === true);

export const useCanReopen = () => useTabs((s) => s.undo.length > 0);

export const useHasArchivedTabs = () => useTabs((s) => s.archivedCount > 0);

export const useArchiveLoaded = () => useTabs((s) => s.archive !== null);

const dayFormat = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export function useArchiveDays(): ArchivedDay[] {
  const archive = useTabs((s) => s.archive);
  return useMemo(() => archiveDays(archive ?? [], dayFormat), [archive]);
}
