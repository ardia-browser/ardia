import type { BrowserState } from "../browser/store";
import { pinHomeOf, tabTitle } from "../browser/model";
import { siteKey } from "../groups/groupNames";
import { dropping } from "../drag/drops";
import { splitRowPanes } from "../splits/splits";
import { sameList } from "../../lib/lists";
import { groupEntries, sidebarEntries } from "./entries";
import { parseEntry } from "./entryKey";

export type SortKey = "site" | "title";

export const SORT_KEYS: readonly SortKey[] = ["site", "title"];

export type SortTarget = { windowId: string; groupId?: string };

export type Sorted = SortTarget & { key: SortKey; before: string[]; after: string[]; tabs: number };

type Place = Pick<BrowserState, "tabs" | "windows" | "groups" | "splits">;

const collator = new Intl.Collator(undefined, { sensitivity: "accent" });

function entriesOf(s: BrowserState, { windowId, groupId }: SortTarget): string[] | null {
  const w = s.windows[windowId];
  if (!w || w.kind === "small") return null;
  if (!groupId) return sidebarEntries(s, windowId).list;
  const g = s.groups[groupId];
  return g && g.windowId === windowId && g.profileId === w.profileId ? groupEntries(s, groupId) : null;
}

function entryTabIds(s: Place, windowId: string, entry: string): string[] {
  const { kind, id } = parseEntry(entry);
  const members = kind === "group" ? (s.groups[id]?.tabIds ?? []) : kind === "split" ? splitRowPanes(s, s.splits[id]) : [id];
  const set = new Set(members);
  return (s.windows[windowId]?.tabIds ?? []).filter((t) => set.has(t));
}

const sorts = (entry: string) => parseEntry(entry).kind !== "group";

function sortedEntries(s: BrowserState, windowId: string, entries: string[], key: SortKey): string[] {
  const keyed = entries.filter(sorts).map((entry, at) => {
    const tab = s.tabs[entryTabIds(s, windowId, entry)[0] ?? ""];
    return { entry, at, site: tab ? siteKey(pinHomeOf(tab)) : "", title: tab ? tabTitle(tab) : "" };
  });
  const bySite = (a: (typeof keyed)[number], z: (typeof keyed)[number]) => (key === "site" ? Number(!a.site) - Number(!z.site) || collator.compare(a.site, z.site) : 0);
  keyed.sort((a, z) => bySite(a, z) || collator.compare(a.title, z.title) || a.at - z.at);
  let next = 0;
  return entries.map((entry) => (sorts(entry) ? keyed[next++]!.entry : entry));
}

export function sortableCount(s: BrowserState, target: SortTarget): number {
  return entriesOf(s, target)?.filter(sorts).length ?? 0;
}

export function sortPlan(s: BrowserState, target: SortTarget, key: SortKey): string[] | null {
  const entries = entriesOf(s, target);
  if (!entries || entries.filter(sorts).length < 2) return null;
  const after = sortedEntries(s, target.windowId, entries, key);
  return sameList(after, entries) ? null : after;
}

export const canSort = (s: BrowserState, target: SortTarget, key: SortKey) => !!sortPlan(s, target, key);

function inPlace(s: Place, windowId: string, container: ReadonlySet<string>, ids: string[], beforeId: string | null): boolean {
  const order = (s.windows[windowId]?.tabIds ?? []).filter((id) => container.has(id));
  const at = order.indexOf(ids.at(-1)!);
  return at >= 0 && (order[at + 1] ?? null) === beforeId;
}

function arranged(s: BrowserState, target: SortTarget, order: string[]): BrowserState {
  const { windowId, groupId } = target;
  const container = new Set(order.flatMap((entry) => entryTabIds(s, windowId, entry)));
  let next = s;
  for (let i = order.length - 1; i >= 0; i--) {
    if (!sorts(order[i]!)) continue;
    const ids = entryTabIds(next, windowId, order[i]!);
    if (!ids.length) continue;
    const beforeId = order[i + 1] ? (entryTabIds(next, windowId, order[i + 1]!)[0] ?? null) : null;
    if (inPlace(next, windowId, container, ids, beforeId)) continue;
    next = dropping(next, ids, { type: "tabs", placement: { pinned: false, groupId: groupId ?? null, beforeId } });
  }
  return next;
}

export function sorting(s: BrowserState, target: SortTarget, key: SortKey): [BrowserState, Sorted | null] {
  const before = entriesOf(s, target);
  const after = sortPlan(s, target, key);
  if (!before || !after) return [s, null];
  const tabs = before.filter(sorts).reduce((n, entry) => n + entryTabIds(s, target.windowId, entry).length, 0);
  const next = arranged(s, target, after);
  const now = entriesOf(next, target);
  return now && sameList(now, after) ? [next, { ...target, key, before: [...before], after: [...now], tabs }] : [s, null];
}

function undoOrder(s: BrowserState, sorted: Sorted): string[] | null {
  const now = entriesOf(s, sorted);
  if (!now) return null;
  const live = new Set(now);
  const was = new Set(sorted.before);
  const kept = now.filter((e) => was.has(e));
  const back = sorted.before.filter((e) => live.has(e));
  if (!sameList(kept, sorted.after.filter((e) => live.has(e))) || sameList(kept, back)) return null;
  let next = 0;
  return now.map((e) => (was.has(e) ? back[next++]! : e));
}

export const canUndoSort = (s: BrowserState, sorted: Sorted) => !!undoOrder(s, sorted);

export function unsorting(s: BrowserState, sorted: Sorted): BrowserState {
  const order = undoOrder(s, sorted);
  return order ? arranged(s, sorted, order) : s;
}
