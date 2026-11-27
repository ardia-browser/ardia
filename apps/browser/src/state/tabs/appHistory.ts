import type { AppHistory, AppHistoryEntry, Tab } from "../browser/types";
import { isFields, isString } from "../../lib/decode";

export const MAX_APP_HISTORY = 50;
const MAX_ENTRY_URL = 4096;
const MAX_ENTRY_TITLE = 1024;

const at = (h: AppHistory | undefined): AppHistoryEntry | undefined => h?.entries[h.index];

export const currentAppEntry = (t: Pick<Tab, "appHistory"> | undefined) => at(t?.appHistory);

export function appHistoryStep(h: AppHistory | undefined, direction: -1 | 1): number | null {
  if (!h) return null;
  const next = h.index + direction;
  return next >= 0 && next < h.entries.length ? next : null;
}

function capped(h: AppHistory): AppHistory {
  const over = h.entries.length - MAX_APP_HISTORY;
  if (over <= 0) return h;
  const kept = h.kept && h.kept.index >= over ? { ...h.kept, index: h.kept.index - over } : undefined;
  return { entries: h.entries.slice(over), index: h.index - over, ...(kept ? { kept } : {}) };
}

const withoutKeptPast = (h: AppHistory, last: number): AppHistory => {
  if (!h.kept || h.kept.index <= last) return h;
  const { kept: _, ...rest } = h;
  return rest;
};

export function pushedEntry(h: AppHistory | undefined, entry: AppHistoryEntry, replace = false): AppHistory {
  if (!h || !h.entries.length) return { entries: [entry], index: 0 };
  if (replace) {
    const entries = h.entries.slice();
    entries[h.index] = entry;
    return h.kept?.index === h.index ? takenKept({ ...h, entries }) : { ...h, entries };
  }
  const keep = h.index + 1;
  const trimmed = withoutKeptPast(h, keep - 1);
  return capped({ ...trimmed, entries: [...h.entries.slice(0, keep), entry], index: keep });
}

export function withCurrentEntry(h: AppHistory, patch: Partial<AppHistoryEntry>): AppHistory {
  const current = at(h);
  if (!current) return h;
  const next = { ...current, ...patch };
  if (next.url === current.url && next.title === current.title) return h;
  const entries = h.entries.slice();
  entries[h.index] = next;
  return { ...h, entries };
}

export function withoutForward(h: AppHistory): AppHistory {
  if (h.index >= h.entries.length - 1) return h;
  return withoutKeptPast({ ...h, entries: h.entries.slice(0, h.index + 1) }, h.index);
}

export const movedTo = (h: AppHistory, index: number): AppHistory => ({ ...h, index });

export const keptAt = (h: AppHistory, index: number, key: string): AppHistory => ({ ...h, kept: { index, key } });

export function takenKept(h: AppHistory): AppHistory {
  if (!h.kept) return h;
  const { kept: _, ...rest } = h;
  return rest;
}

const entryFromDisk = (v: unknown): AppHistoryEntry | null =>
  isFields(v) && isString(v.url) && v.url.length <= MAX_ENTRY_URL && isString(v.title) ? { url: v.url, title: v.title.slice(0, MAX_ENTRY_TITLE) } : null;

export function appHistoryFromDisk(v: unknown): AppHistory | undefined {
  if (!isFields(v) || !Array.isArray(v.entries) || !Number.isInteger(v.index)) return undefined;
  const entries = v.entries.slice(-MAX_APP_HISTORY).map(entryFromDisk);
  if (!entries.length || entries.some((e) => !e)) return undefined;
  const shift = v.entries.length - entries.length;
  const index = (v.index as number) - shift;
  if (index < 0 || index >= entries.length) return undefined;
  const k = isFields(v.kept) ? v.kept : null;
  const keptIndex = k && Number.isInteger(k.index) ? (k.index as number) - shift : -1;
  const kept = k && isString(k.key) && k.key.length <= 200 && keptIndex >= 0 && keptIndex < entries.length ? { index: keptIndex, key: k.key } : undefined;
  return { entries: entries as AppHistoryEntry[], index, ...(kept ? { kept } : {}) };
}
