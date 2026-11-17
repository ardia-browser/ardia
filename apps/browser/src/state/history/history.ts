import { deleteHistoryUrls, importHistoryRows } from "../../platform/history";
import type { StateCreator } from "zustand";
import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { engineProfiles } from "../profiles/engineProfiles";
import type { HistoryEntry } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";

export type HistoryView = { list: HistoryEntry[]; floor: number; ready: boolean };

export type HistorySlice = {
  history: Record<string, HistoryView>;

  removeHistory(profileId: string, urls: string[]): void;
  clearHistory(profileId: string, since?: number, until?: number): void;
  importHistory(profileId: string, entries: Omit<HistoryEntry, "favicon">[]): number;
};

export const MAX_HISTORY = 100_000;
export const MAX_VISIT_TIMES = 50;
export const SUGGESTION_HISTORY = 5000;
export const SUGGESTION_FREQUENT = 2000;
export const FREQUENT_VISITS = 4;

export const NO_HISTORY: HistoryEntry[] = [];

type HistoryState = Pick<BrowserState, "profiles" | "history">;

export const historyViewOf = (s: HistoryState, profileId: string): HistoryView | undefined => s.history[engineProfile(s, profileId)];

export const historyOf = (s: HistoryState, profileId: string): HistoryEntry[] => historyViewOf(s, profileId)?.list ?? NO_HISTORY;

const newestPages = new WeakMap<HistoryEntry[], HistoryEntry[]>();

export function suggestionHistory(list: HistoryEntry[]): HistoryEntry[] {
  if (list.length <= SUGGESTION_HISTORY) return list;
  let newest = newestPages.get(list);
  if (!newest) {
    newest = list.slice(0, SUGGESTION_HISTORY);
    let frequent = 0;
    for (let i = SUGGESTION_HISTORY; i < list.length && frequent < SUGGESTION_FREQUENT; i++) {
      if (list[i]!.visits < FREQUENT_VISITS) continue;
      newest.push(list[i]!);
      frequent++;
    }
    newestPages.set(list, newest);
  }
  return newest;
}

export const suggestionHistoryOf = (s: HistoryState, profileId: string): HistoryEntry[] => suggestionHistory(historyOf(s, profileId));

export function withHistoryList(s: HistoryState, engine: string, list: HistoryEntry[]): Partial<Pick<BrowserState, "history">> {
  if (!engineProfiles(s).includes(engine)) return {};
  const was = s.history[engine];
  return { history: { ...s.history, [engine]: { list, floor: was?.floor ?? -Infinity, ready: was?.ready ?? false } } };
}

function withoutVisitsBetween(entry: HistoryEntry, since: number, until: number): HistoryEntry | null {
  if (entry.lastVisit < since) return entry;
  const times = entry.visitTimes?.length ? entry.visitTimes : [entry.lastVisit];
  const kept = times.filter((t) => t < since || t > until);
  if (kept.length === times.length) return entry;
  if (!kept.length) return null;
  kept.sort((a, b) => a - b);
  return { ...entry, visits: entry.visits - (times.length - kept.length), lastVisit: kept[kept.length - 1]!, visitTimes: kept };
}

const failed = (what: string) => (error: unknown) => console.warn(`[history] ${what}`, error);

export const createHistorySlice: StateCreator<BrowserState, [], [], HistorySlice> = (set, get) => ({
  history: {},

  removeHistory(profileId, urls) {
    if (!urls.length || isIncognitoProfile(profileId)) return;
    const gone = new Set(urls);
    set((s) => withHistoryList(s, engineProfile(s, profileId), historyOf(s, profileId).filter((h) => !gone.has(h.url))));
    void deleteHistoryUrls(engineProfile(get(), profileId), urls).catch(failed("delete"));
  },

  importHistory(profileId, entries) {
    if (isIncognitoProfile(profileId)) return 0;
    const rows = entries.filter((e) => isWebPageUrl(e.url));
    let added = 0;
    set((s) => {
      const byUrl = new Map(historyOf(s, profileId).map((h) => [h.url, h]));
      for (const e of rows) {
        const existing = byUrl.get(e.url);
        if (existing) continue;
        added++;
        byUrl.set(e.url, { url: e.url, title: e.title, favicon: null, visits: Math.max(1, e.visits), lastVisit: e.lastVisit, visitTimes: [e.lastVisit] });
      }
      const merged = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, MAX_HISTORY);
      return withHistoryList(s, engineProfile(s, profileId), merged);
    });
    void importHistoryRows(engineProfile(get(), profileId), rows).catch(failed("import"));
    return added;
  },

  clearHistory(profileId, since, until = Infinity) {
    if (isIncognitoProfile(profileId)) return;
    set((s) => {
      const engine = engineProfile(s, profileId);
      if (since === undefined && until === Infinity) return withHistoryList(s, engine, []);
      const kept = historyOf(s, profileId).map((h) => withoutVisitsBetween(h, since ?? -Infinity, until)).filter((h): h is HistoryEntry => !!h);
      return withHistoryList(s, engine, kept.sort((a, b) => b.lastVisit - a.lastVisit));
    });
  },
});
