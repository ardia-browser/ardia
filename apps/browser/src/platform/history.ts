import {
  addHistoryVisits as engineAddHistoryVisits,
  onHistoryChanged as engineOnHistoryChanged,
  queryHistory as engineQueryHistory,
  type EngineHistoryEntry,
  type HistoryChange,
} from "@ardia/ardiacore";

export { importHistoryRows, deleteHistoryUrls, watchHistory, type EngineHistoryEntry, type HistoryChange } from "@ardia/ardiacore";

export const queryHistoryUnfiltered = engineQueryHistory;

export type HistoryFilter = { hides: (url: string) => boolean; hidden: (profile: string, urls: string[]) => void };

let filter: HistoryFilter | null = null;

export const setHistoryFilter = (next: HistoryFilter | null) => void (filter = next);

const shown = (url: string) => !filter || !filter.hides(url);

export const queryHistory = async (...args: Parameters<typeof engineQueryHistory>): Promise<EngineHistoryEntry[]> => {
  const entries = await engineQueryHistory(...args);
  return filter ? entries.filter((e) => shown(e.url)) : entries;
};

export const addHistoryVisits: typeof engineAddHistoryVisits = (profile, visits, ...rest) =>
  engineAddHistoryVisits(profile, filter ? visits.filter((v) => shown(v.url)) : visits, ...rest);

function filtered(change: HistoryChange): HistoryChange | null {
  if (!filter || change.kind === "deleted") return change;
  if (change.kind === "visit") {
    if (shown(change.url)) return change;
    filter.hidden(change.profile, [change.url]);
    return null;
  }
  const hidden = change.rows.filter((r) => !shown(r.url)).map((r) => r.url);
  if (!hidden.length) return change;
  filter.hidden(change.profile, hidden);
  const rows = change.rows.filter((r) => shown(r.url));
  return rows.length ? { ...change, rows } : null;
}

export const onHistoryChanged = (listener: (change: HistoryChange) => void) =>
  engineOnHistoryChanged((change) => {
    const kept = filtered(change);
    if (kept) listener(kept);
  });
