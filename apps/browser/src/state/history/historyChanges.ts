import type { HistoryChange } from "../../platform/history";
import type { HistoryEntry } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "./historyLimits";

export type ListChange = Exclude<HistoryChange, { kind: "deleted"; all: true }>;
export type HistoryGap = `${HistoryChange["kind"]}-${"unloaded" | "moving"}` | "modified-unknown" | "visit-untitled";
export type NoteGap = (gap: HistoryGap, count?: number) => void;

type Entry = Readonly<HistoryEntry>;
type UrlIndex = Map<string, Entry>;
type Touched = { entry: Entry | undefined; first: Entry | undefined; index: number; moved: boolean; seq: number };

const MAX_INDEXED_TOUCHES = 64;
const UNKNOWN_INDEX = -2;
const MAX_TIE_STEPS = 2048;

export const isListChange = (change: HistoryChange): change is ListChange => change.kind !== "deleted" || !change.all;

const urlsOf = (change: ListChange): string[] =>
  change.kind === "visit" ? [change.url] : change.kind === "modified" ? change.rows.map((r) => r.url) : change.urls;

const urlIndexes = new WeakMap<readonly Entry[], UrlIndex | null>();

export const historyApplyStats = { indexed: 0, scanned: 0, indexBuilds: 0 };

export const historyListIndexed = (list: readonly Entry[]) => !!urlIndexes.get(list);

export const historyBatchUsesIndex = (changes: readonly ListChange[]) => new Set(changes.flatMap(urlsOf)).size <= MAX_INDEXED_TOUCHES;

export function indexHistoryList(list: readonly Entry[]): boolean {
  let index = urlIndexes.get(list);
  if (index !== undefined) return index !== null;
  historyApplyStats.indexBuilds++;
  const byUrl: UrlIndex = new Map();
  let newestFirst = true;
  for (let i = 0; i < list.length; i++) {
    const h = list[i]!;
    byUrl.set(h.url, h);
    if (i && list[i - 1]!.lastVisit < h.lastVisit) newestFirst = false;
  }
  index = newestFirst && byUrl.size === list.length ? byUrl : null;
  urlIndexes.set(list, index);
  return index !== null;
}

function touchedBy(list: readonly Entry[], wanted: Set<string>, byUrl: UrlIndex | null): Map<string, Touched> {
  const touched = new Map<string, Touched>();
  if (byUrl) {
    for (const url of wanted) {
      const entry = byUrl.get(url);
      if (entry) touched.set(url, { entry, first: entry, index: UNKNOWN_INDEX, moved: false, seq: 0 });
    }
    return touched;
  }
  for (let i = 0; i < list.length; i++) {
    const h = list[i]!;
    if (wanted.has(h.url) && !touched.has(h.url)) touched.set(h.url, { entry: h, first: h, index: i, moved: false, seq: 0 });
  }
  return touched;
}

function applyToTouched(changes: readonly ListChange[], touched: Map<string, Touched>, note?: NoteGap): boolean {
  const stateOf = (url: string) => {
    let state = touched.get(url);
    if (!state) touched.set(url, (state = { entry: undefined, first: undefined, index: -1, moved: false, seq: 0 }));
    return state;
  };
  let seq = 0;
  let dirty = false;
  for (const change of changes) {
    switch (change.kind) {
      case "visit": {
        if (!isWebPageUrl(change.url)) break;
        const state = stateOf(change.url);
        const old = state.entry;
        if (old?.visitTimes?.includes(change.at)) break;
        const times = [...(old?.visitTimes ?? []), change.at].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);
        state.entry = {
          url: change.url,
          title: change.title || old?.title || "",
          favicon: null,
          visits: Math.max(change.visits, 1),
          lastVisit: times[times.length - 1]!,
          visitTimes: times,
        };
        if (!state.entry.title) note?.("visit-untitled");
        state.moved = true;
        state.seq = ++seq;
        dirty = true;
        break;
      }
      case "modified": {
        for (const row of new Map(change.rows.map((r) => [r.url, r])).values()) {
          const state = touched.get(row.url);
          const h = state?.entry;
          if (!h && isWebPageUrl(row.url)) note?.("modified-unknown");
          if (!state || !h || ((row.title === h.title || !row.title) && row.visits === h.visits)) continue;
          state.entry = { ...h, title: row.title || h.title, visits: row.visits };
          dirty = true;
        }
        break;
      }
      case "deleted": {
        for (const url of change.urls) {
          const state = touched.get(url);
          if (!state?.entry) continue;
          state.entry = undefined;
          dirty = true;
        }
        break;
      }
    }
  }
  return dirty;
}

const newestMovedFirst = (a: Touched, b: Touched) => b.entry!.lastVisit - a.entry!.lastVisit || b.seq - a.seq;

function mergedByScan(list: readonly Entry[], touched: Map<string, Touched>): HistoryEntry[] {
  const replaced: Touched[] = [];
  const moved: Touched[] = [];
  for (const state of touched.values()) {
    if (state.moved && state.entry) moved.push(state);
    if (state.index >= 0) replaced.push(state);
  }
  replaced.sort((a, b) => a.index - b.index);
  moved.sort(newestMovedFirst);
  const next: HistoryEntry[] = [];
  let m = 0;
  let r = 0;
  for (let i = 0; i < list.length && next.length < MAX_HISTORY; i++) {
    let h: Entry | undefined = list[i]!;
    if (r < replaced.length && replaced[r]!.index === i) {
      const state = replaced[r++]!;
      h = state.moved ? undefined : state.entry;
    }
    if (!h) continue;
    while (m < moved.length && moved[m]!.entry!.lastVisit >= h.lastVisit) next.push(moved[m++]!.entry!);
    next.push(h);
  }
  while (m < moved.length) next.push(moved[m++]!.entry!);
  if (next.length > MAX_HISTORY) next.length = MAX_HISTORY;
  return next;
}

function firstAtOrBefore(list: readonly Entry[], lastVisit: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.lastVisit <= lastVisit) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function positionsOf(list: readonly Entry[], entries: readonly Entry[]): Map<Entry, number> | null {
  const byTime = new Map<number, Set<Entry>>();
  for (const entry of entries) {
    const group = byTime.get(entry.lastVisit);
    if (group) group.add(entry);
    else byTime.set(entry.lastVisit, new Set([entry]));
  }
  const positions = new Map<Entry, number>();
  let steps = MAX_TIE_STEPS;
  for (const [lastVisit, group] of byTime) {
    let left = group.size;
    for (let i = firstAtOrBefore(list, lastVisit); left && i < list.length && list[i]!.lastVisit === lastVisit; i++) {
      if (--steps < 0) return null;
      if (group.has(list[i]!) && !positions.has(list[i]!)) {
        positions.set(list[i]!, i);
        left--;
      }
    }
    if (left) return null;
  }
  return positions;
}

function indexesByScan(list: readonly Entry[], touched: Map<string, Touched>) {
  const firsts = new Map<Entry, Touched>();
  for (const state of touched.values()) if (state.first && state.index === UNKNOWN_INDEX) firsts.set(state.first, state);
  for (let i = 0; i < list.length && firsts.size; i++) {
    const state = firsts.get(list[i]!);
    if (!state) continue;
    state.index = i;
    firsts.delete(list[i]!);
  }
  for (const state of firsts.values()) state.index = -1;
}

type Merged = { next: HistoryEntry[]; dropped: readonly Entry[] };

function mergedByIndex(list: readonly Entry[], touched: Map<string, Touched>): Merged | null {
  const slots = new Map<number, Entry | null>();
  const moved: Touched[] = [];
  const changed: Touched[] = [];
  for (const state of touched.values()) {
    if (state.moved && state.entry) moved.push(state);
    if (state.first && (state.entry !== state.first || state.moved)) changed.push(state);
  }
  const positions = positionsOf(list, changed.map((state) => state.first!));
  if (!positions) return null;
  for (const state of changed) {
    state.index = positions.get(state.first!)!;
    slots.set(state.index, state.moved ? null : (state.entry ?? null));
  }
  moved.sort(newestMovedFirst);
  const inserts = moved.map((state) => firstAtOrBefore(list, state.entry!.lastVisit));
  const cuts = [...new Set([...slots.keys(), ...inserts])].sort((a, b) => a - b);
  const parts: (Entry | readonly Entry[])[] = [];
  let from = 0;
  let m = 0;
  for (const cut of cuts) {
    if (cut > from) parts.push(list.slice(from, cut));
    while (m < moved.length && inserts[m] === cut) parts.push(moved[m++]!.entry!);
    if (slots.has(cut)) {
      const kept = slots.get(cut);
      if (kept) parts.push(kept);
      from = cut + 1;
    } else from = cut;
  }
  if (from < list.length) parts.push(list.slice(from));
  const next = ([] as HistoryEntry[]).concat(...(parts as HistoryEntry[][]));
  const dropped = next.length > MAX_HISTORY ? next.slice(MAX_HISTORY) : [];
  if (dropped.length) next.length = MAX_HISTORY;
  return { next, dropped };
}

function carryIndex(byUrl: UrlIndex, list: readonly Entry[], { next, dropped }: Merged, touched: Map<string, Touched>) {
  urlIndexes.delete(list);
  for (const [url, state] of touched) {
    if (state.entry) byUrl.set(url, state.entry);
    else byUrl.delete(url);
  }
  for (const entry of dropped) if (byUrl.get(entry.url) === entry) byUrl.delete(entry.url);
  urlIndexes.set(next, byUrl.size === next.length ? byUrl : null);
}

export function applyHistoryChanges(list: HistoryEntry[], changes: readonly ListChange[], note?: NoteGap): HistoryEntry[] {
  if (!changes.length) return list;
  const wanted = new Set(changes.flatMap(urlsOf));
  const byUrl = wanted.size <= MAX_INDEXED_TOUCHES ? (urlIndexes.get(list) ?? null) : null;
  const touched = touchedBy(list, wanted, byUrl);
  if (!applyToTouched(changes, touched, note)) return list;
  if (byUrl) {
    const merged = mergedByIndex(list, touched);
    if (merged) {
      historyApplyStats.indexed++;
      carryIndex(byUrl, list, merged, touched);
      return merged.next;
    }
    indexesByScan(list, touched);
  }
  historyApplyStats.scanned++;
  return mergedByScan(list, touched);
}
