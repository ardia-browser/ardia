import { deleteHistoryUrls, importHistoryRows } from "../../platform/history";
import type { StateCreator } from "zustand";
import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { engineProfiles } from "../profiles/engineProfiles";
import type { ClosedTab, HistoryEntry } from "../browser/types";
import { withImportedCleaned } from "../pins/importedCleaned";
import { isWebPageUrl } from "../../lib/url";

export type HistoryView = { list: HistoryEntry[]; floor: number; ready: boolean; reloads?: number };

export type HistorySlice = {
  history: Record<string, HistoryView>;

  removeHistory(profileId: string, urls: string[]): Promise<void>;
  clearHistory(profileId: string, since?: number, until?: number): void;
  importHistory(profileId: string, entries: Omit<HistoryEntry, "favicon">[]): Promise<HistoryImportOutcome>;
  importCleanedTabs(entries: ClosedTab[]): { added: number; already: number };
};

export type HistoryImportOutcome = { added: number; batches: number; failedBatches: number };

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

const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.lastVisit - a.lastVisit;

type RunningImport = { engine: string; removed: Set<string>; cleared: { since: number; until: number }[] };
const runningImports = new Set<RunningImport>();

const importsInto = (engine: string) => [...runningImports].filter((run) => run.engine === engine);

export function skipInRunningImports(engine: string, since: number | undefined, until: number) {
  const range = { since: since ?? -Infinity, until };
  const runs = importsInto(engine);
  for (const run of runs) run.cleared.push(range);
  return () => {
    for (const run of runs) run.cleared = run.cleared.filter((r) => r !== range);
  };
}

export const createHistorySlice: StateCreator<BrowserState, [], [], HistorySlice> = (set, get) => ({
  history: {},

  removeHistory(profileId, urls) {
    if (!urls.length || isIncognitoProfile(profileId)) return Promise.resolve();
    const gone = new Set(urls);
    for (const run of importsInto(engineProfile(get(), profileId))) for (const url of urls) run.removed.add(url);
    set((s) => withHistoryList(s, engineProfile(s, profileId), historyOf(s, profileId).filter((h) => !gone.has(h.url))));
    const deleted = deleteHistoryUrls(engineProfile(get(), profileId), urls).then(() => undefined);
    deleted.catch(failed("delete"));
    return deleted;
  },

  importCleanedTabs(entries) {
    const { cleanedTabs, added, already } = withImportedCleaned(get(), entries);
    if (added) set({ cleanedTabs });
    return { added, already };
  },

  async importHistory(profileId, entries) {
    if (isIncognitoProfile(profileId)) return { added: 0, batches: 0, failedBatches: 0 };
    const rows = entries.filter((e) => isWebPageUrl(e.url) && e.lastVisit > 0);
    const placed = new Map<string, HistoryEntry>();
    let evicted: HistoryEntry[] = [];
    set((s) => {
      const byUrl = new Map(historyOf(s, profileId).map((h) => [h.url, h]));
      for (const e of rows) {
        if (byUrl.has(e.url)) continue;
        const entry = { url: e.url, title: e.title, favicon: null, visits: Math.max(1, e.visits), lastVisit: e.lastVisit, visitTimes: [e.lastVisit] };
        byUrl.set(e.url, entry);
        placed.set(e.url, entry);
      }
      const merged = [...byUrl.values()].sort(newestFirst);
      evicted = merged.slice(MAX_HISTORY).filter((h) => placed.get(h.url) !== h);
      return withHistoryList(s, engineProfile(s, profileId), merged.slice(0, MAX_HISTORY));
    });
    const run: RunningImport = { engine: engineProfile(get(), profileId), removed: new Set(), cleared: [] };
    const stillWanted = (row: { url: string; lastVisit: number }) =>
      !run.removed.has(row.url) && !run.cleared.some((c) => row.lastVisit >= c.since && row.lastVisit <= c.until);
    runningImports.add(run);
    const { written, batches, failures } = await importHistoryRows(run.engine, rows, stillWanted).finally(() => runningImports.delete(run));
    failures.forEach(failed("import"));
    const landed = new Set(written.map((r) => r.url));
    const unsaved = new Set([...placed].filter(([url]) => !landed.has(url)).map(([, entry]) => entry));
    set((s) => {
      const list = historyOf(s, profileId);
      const kept = unsaved.size ? list.filter((h) => !unsaved.has(h)) : list;
      const listed = new Set(kept.map((h) => h.url));
      const missing = [...placed.values()].filter((h) => !unsaved.has(h) && !listed.has(h.url) && stillWanted(h));
      const back = unsaved.size ? evicted.filter((h) => !listed.has(h.url) && stillWanted(h)) : [];
      if (kept.length === list.length && !missing.length && !back.length) return s;
      return withHistoryList(s, engineProfile(s, profileId), [...kept, ...missing, ...back].sort(newestFirst).slice(0, MAX_HISTORY));
    });
    return { added: placed.size - unsaved.size, batches, failedBatches: failures.length };
  },

  clearHistory(profileId, since, until = Infinity) {
    if (isIncognitoProfile(profileId)) return;
    skipInRunningImports(engineProfile(get(), profileId), since, until);
    set((s) => {
      const engine = engineProfile(s, profileId);
      if (since === undefined && until === Infinity) return withHistoryList(s, engine, []);
      const kept = historyOf(s, profileId).map((h) => withoutVisitsBetween(h, since ?? -Infinity, until)).filter((h): h is HistoryEntry => !!h);
      return withHistoryList(s, engine, kept.sort((a, b) => b.lastVisit - a.lastVisit));
    });
  },
});
