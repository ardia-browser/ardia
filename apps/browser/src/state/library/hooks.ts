import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBrowser, type BrowserState } from "../browser/store";
import { currentEngineProfile } from "../browser/current";
import { downloadVisibleIn } from "../downloads/downloadsSlice";
import { useProfileHistory, useWindowHistory } from "../history/hooks";
import { NO_HISTORY } from "../history/history";
import { useFullscreenTab } from "../tabs/pageState";
import type { Download } from "../../platform/downloads";
import { dayStart } from "../../lib/textSearch";
import { CLOSED_LIBRARY, libraryAvailable, librarySectionsFor, mediaKindOf, useLibrary, type LibrarySection, type MediaKind } from "./library";
import { useFolderMedia, type FolderListing, type FolderMediaStatus } from "./folderMedia";
import { libraryMergesProfiles, libraryProfileFilterOf, parseVisitKey, profileSearchOf, scopedHistory, sharedProfileOwners, type ProfileOwners } from "./profileScope";
import { downloadsOwnedIn, libraryDownloadsOf, libraryMediaOf } from "./derived";
import { noteLibrarySearch } from "../telemetry/libraryCounts";
import { dayGroups, primeSearchText, profileItems, refinedSearch, type DayGroup, type HistoryItem, type LibraryItems, type SearchMemo } from "./items";

export type LibraryItemsOf = { [S in LibrarySection]: readonly LibraryItems[S][number][] };

const NO_DOWNLOADS: Download[] = [];
const NO_COUNTS: Record<string, number> = {};
const PRIME_SLICE_MS = 6;
const searchMemos = new WeakMap<object, SearchMemo<LibraryItemsOf[LibrarySection][number]>>();
const dayGroupsMemo = new WeakMap<object, { today: number; groups: DayGroup<unknown>[] }>();
const PRIME_GAP_MS = 24;

export const useLibraryOpen = (windowId: string): boolean => useLibrary((s) => !!s.windows[windowId]?.open);

export const useLibrarySection = (windowId: string): LibrarySection => useLibrary((s) => (s.windows[windowId] ?? CLOSED_LIBRARY).section);

export const useLibraryQuery = (windowId: string): string => useLibrary((s) => (s.windows[windowId] ?? CLOSED_LIBRARY).query);

export const useLibraryFilter = (windowId: string): MediaKind => useLibrary((s) => mediaKindOf(s.windows[windowId] ?? CLOSED_LIBRARY));

export const useLibraryListScope = (windowId: string): string =>
  useLibrary((s) => {
    const w = s.windows[windowId] ?? CLOSED_LIBRARY;
    return `${mediaKindOf(w)}\n${w.profile ?? ""}`;
  });

export const useLibrarySections = (windowId: string): readonly LibrarySection[] => librarySectionsFor(useBrowser((s) => s.windows[windowId]?.kind));

export function useLibraryAvailable(windowId: string): boolean {
  const available = useBrowser((s) => libraryAvailable(s, windowId));
  const fullscreen = !!useFullscreenTab(windowId);
  return available && !fullscreen;
}

export function useSectionLive(windowId: string, section: LibrarySection): boolean {
  return useLibrary((s) => {
    const w = s.windows[windowId];
    return !!w?.open && w.section === section;
  });
}

function useHeld<T>(live: boolean, value: T): T {
  const held = useRef<{ value: T } | null>(null);
  if (live || !held.current) held.current = { value };
  return held.current.value;
}

function useVisibleDownloads(windowId: string, wanted: boolean): Download[] {
  const all = useBrowser((s) => (wanted ? s.downloads : NO_DOWNLOADS));
  const [kind, profileId] = useBrowser(useShallow((s) => [s.windows[windowId]?.kind, s.windows[windowId]?.profileId] as const));
  const profiles = useBrowser((s) => (wanted ? s.profiles : undefined));
  return useMemo(() => {
    if (!wanted || !kind || profileId === undefined || !profiles) return NO_DOWNLOADS;
    const window = { kind, profileId };
    return all.filter((d) => downloadVisibleIn({ profiles }, d, window));
  }, [wanted, all, kind, profileId, profiles]);
}

export type LibraryScope = { merged: boolean; filter: string | null; owners: ProfileOwners; profiles: BrowserState["profiles"] };

const NO_OWNER_MAP: ProfileOwners = new Map();

export function useLibraryScope(windowId: string): LibraryScope {
  const merged = useBrowser((s) => libraryMergesProfiles(s, windowId));
  const chosen = useLibrary((s) => (s.windows[windowId] ?? CLOSED_LIBRARY).profile);
  const filter = useBrowser((s) => libraryProfileFilterOf(s, windowId, chosen));
  const profiles = useBrowser((s) => s.profiles);
  const owners = useBrowser((s) => (merged ? sharedProfileOwners(s) : NO_OWNER_MAP));
  return useMemo(() => ({ merged, filter, owners, profiles }), [merged, filter, owners, profiles]);
}

function useScopedDownloads(windowId: string, wanted: boolean, merged: boolean, owners: ProfileOwners, live: boolean): Download[] {
  const visible = useHeld(live, useVisibleDownloads(windowId, wanted && !merged));
  const all = useHeld(live, useBrowser((s) => (wanted && merged ? s.downloads : NO_DOWNLOADS)));
  return useMemo(() => (merged ? downloadsOwnedIn(all, owners) : visible), [merged, owners, visible, all]);
}

function useScopedFolderMedia(windowId: string, shown: boolean, wanted: boolean, scope: LibraryScope) {
  const profileId = useBrowser((s) => s.windows[windowId]?.profileId);
  const engines = useMemo(() => (scope.merged ? [...scope.owners.keys()] : profileId === undefined ? [] : [currentEngineProfile(profileId)]), [scope.merged, scope.owners, profileId]);
  return useFolderMedia(engines, shown, wanted);
}

function useHistorySource(windowId: string | null, scope: LibraryScope, live = true): readonly HistoryItem[] {
  const own = useHeld(live, useWindowHistory(windowId !== null && !scope.merged ? windowId : null) ?? NO_HISTORY);
  const history = useHeld(live, useBrowser((s) => (windowId !== null && scope.merged ? s.history : undefined)));
  const { merged, owners, filter, profiles } = scope;
  return useMemo(() => (merged && history ? scopedHistory(owners, history, filter, { profiles }) : own), [merged, owners, filter, profiles, own, history]);
}

function useProfileTabCounts(windowId: string, wanted: boolean): Record<string, number> {
  return useBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      if (!wanted || !w) return NO_COUNTS;
      const counts: Record<string, number> = {};
      for (const tabId of w.tabIds) {
        const profileId = s.tabs[tabId]?.profileId;
        if (profileId) counts[profileId] = (counts[profileId] ?? 0) + 1;
      }
      return counts;
    }),
  );
}

function useSourceItems(windowId: string, section: LibrarySection, kind: MediaKind, scope: LibraryScope, live: boolean) {
  const wantsDownloads = section === "media" || section === "downloads";
  const downloads = useScopedDownloads(windowId, wantsDownloads, scope.merged, scope.owners, live);
  const open = useLibraryOpen(windowId);
  const listings = useHeld(live, useScopedFolderMedia(windowId, section === "media", open, scope));
  const history = useHistorySource(section === "history" ? windowId : null, scope, live);
  const counts = useHeld(live, useProfileTabCounts(windowId, section === "profiles"));
  const order = useBrowser((s) => s.profileOrder);
  const profiles = useBrowser((s) => s.profiles);
  const current = useBrowser((s) => {
    const w = s.windows[windowId];
    return w && w.kind !== "private" ? w.profileId : null;
  });
  const isPrivate = useBrowser((s) => s.windows[windowId]?.kind === "private");
  const owners = scope.merged ? scope.owners : null;
  const profile = scope.merged ? scope.filter : null;
  const items = useMemo((): LibraryItemsOf[LibrarySection] => {
    if (section === "media") return libraryMediaOf(downloads, listings, kind, owners, profile);
    if (section === "downloads") return libraryDownloadsOf(downloads, owners, profile);
    if (section === "history") return history;
    return isPrivate ? [] : profileItems(order, profiles, counts, current);
  }, [section, kind, downloads, listings, history, counts, order, profiles, current, isPrivate, owners, profile]);
  return { items, listings };
}

export type MediaFolderProblem = Exclude<FolderMediaStatus, "ok">;

const PROBLEMS_FIRST: readonly MediaFolderProblem[] = ["denied", "missing", "unavailable"];

export const mediaFolderProblem = (listings: readonly Pick<FolderListing, "status">[]): MediaFolderProblem | null =>
  PROBLEMS_FIRST.find((problem) => listings.some((listing) => listing.status === problem)) ?? null;

const historyIndexes = new WeakMap<readonly HistoryItem[], Map<string, HistoryItem>>();

function historyEntryOf(history: readonly HistoryItem[], url: string): HistoryItem | undefined {
  let byUrl = historyIndexes.get(history);
  if (!byUrl) {
    byUrl = new Map();
    for (const entry of history) if (!byUrl.has(entry.url)) byUrl.set(entry.url, entry);
    historyIndexes.set(history, byUrl);
  }
  return byUrl.get(url);
}

export function useLibraryVisit(windowId: string, key: string): LibraryItemsOf["history"][number] | undefined {
  const { profileId, url } = parseVisitKey(key);
  const own = useWindowHistory(windowId) ?? NO_HISTORY;
  const theirs = useProfileHistory(profileId);
  const history = profileId === null ? own : theirs;
  return useMemo(() => historyEntryOf(history, url), [history, url]);
}

export function useLibraryItems<S extends LibrarySection>(windowId: string, section: S): LibraryItemsOf[S] {
  return useLibrarySearch(windowId, section).items;
}

const insideFolder = (path: string, folder: string) => path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

export function withoutMissingFolders<T extends { download: { path: string } }>(items: readonly T[], listings: readonly Pick<FolderListing, "folder" | "status">[]): readonly T[] {
  const missing = listings.filter((listing) => listing.status === "missing").map((listing) => listing.folder);
  if (!missing.length) return items;
  const kept = items.filter((item) => !missing.some((folder) => insideFolder(item.download.path, folder)));
  return kept.length === items.length ? items : kept;
}

export function useLibraryMedia(windowId: string): { items: LibraryItemsOf["media"]; folderProblem: MediaFolderProblem | null } {
  const { items, listings } = useLibrarySearch(windowId, "media");
  return useMemo(() => ({ items: withoutMissingFolders(items, listings), folderProblem: mediaFolderProblem(listings) }), [items, listings]);
}

function useLibrarySearch<S extends LibrarySection>(windowId: string, section: S): { items: LibraryItemsOf[S]; listings: readonly FolderListing[] } {
  const live = useSectionLive(windowId, section);
  const kind = useHeld(live, useLibraryFilter(windowId));
  const query = useHeld(live, useDeferredValue(useLibraryQuery(windowId)));
  const scope = useHeld(live, useLibraryScope(windowId));
  const { items: source, listings } = useSourceItems(windowId, section, kind, scope, live);
  const extra = scope.merged ? profileSearchOf(scope.profiles) : undefined;
  const memo = useRef<SearchMemo<LibraryItemsOf[LibrarySection][number]>>(null);
  const timedSearch = useRef<{ ms: number } | null>(null);
  useEffect(() => (live && section !== "profiles" ? primeSearchText(source, PRIME_SLICE_MS, PRIME_GAP_MS, extra) : undefined), [live, section, source, extra]);
  const result = useMemo(() => {
    const kept = memo.current?.source === source ? memo.current : (searchMemos.get(source) ?? null);
    const start = performance.now();
    const next = refinedSearch(kept, source, query, extra);
    timedSearch.current = next !== kept && next.query ? { ms: performance.now() - start } : null;
    memo.current = next;
    searchMemos.set(source, next);
    return memo.current.result;
  }, [source, query, extra]) as LibraryItemsOf[S];
  useEffect(() => {
    const timed = timedSearch.current;
    timedSearch.current = null;
    if (timed) noteLibrarySearch(timed.ms);
  }, [result]);
  return { items: result, listings };
}

function msUntilTomorrow(now: number) {
  const d = new Date(dayStart(now));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now;
}

export function useLibraryToday(active = true): number {
  const [today, setToday] = useState(() => dayStart(Date.now()));
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    if (dayStart(now) !== today) return setToday(dayStart(now));
    const timer = setTimeout(() => setToday(dayStart(Date.now())), msUntilTomorrow(now) + 1000);
    return () => clearTimeout(timer);
  }, [active, today]);
  return today;
}

export function libraryDayGroups<T extends { at: number | undefined } | { lastVisit: number }>(items: readonly T[], today: number): DayGroup<T>[] {
  const kept = dayGroupsMemo.get(items);
  if (kept?.today === today) return kept.groups as DayGroup<T>[];
  const groups = dayGroups(items, Math.max(Date.now(), today));
  dayGroupsMemo.set(items, { today, groups });
  return groups;
}

export function useLibraryDayGroups<S extends "media" | "downloads" | "history">(windowId: string, section: S): DayGroup<LibraryItemsOf[S][number]>[] {
  const items = useLibraryItems(windowId, section);
  const today = useLibraryToday(useLibraryOpen(windowId));
  return useMemo(() => libraryDayGroups(items as readonly LibraryItemsOf[S][number][], today), [items, today]);
}
