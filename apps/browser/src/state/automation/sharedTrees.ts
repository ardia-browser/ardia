import type { BrowserState } from "../browser/store";
import type { BrowserWindow, Tab, TabGroup } from "../browser/types";
import { pinKeyOf } from "../browser/model";
import { descendantIds } from "../groups/groups";
import { splitTabIds } from "../splits/splits";
import { boundFolders } from "../sharedFolders/store";

type Trees = { groups: Set<string>; tabs: Set<string> };

function boundTrees(s: BrowserState): Trees {
  const bound = new Set(boundFolders().map(({ profileId, key }) => `${profileId}\u0001${key}`));
  const groups = new Set<string>();
  const tabs = new Set<string>();
  for (const g of Object.values(s.groups)) {
    if (!g.pinned || g.parentId || !bound.has(`${g.profileId}\u0001${pinKeyOf(g)}`)) continue;
    for (const id of [g.id, ...descendantIds(s.groups, g.id)]) {
      groups.add(id);
      for (const t of s.groups[id]?.tabIds ?? []) tabs.add(t);
    }
  }
  return { groups, tabs };
}

function withEntries<T>(into: Record<string, T>, from: Record<string, T>, ids: Iterable<string>): Record<string, T> {
  const out = { ...into };
  for (const id of ids) {
    if (from[id]) out[id] = from[id]!;
    else delete out[id];
  }
  return out;
}

function placeIn(order: string[], wanted: string[], fromOrder: string[]): string[] {
  const out = order.filter((id) => !wanted.includes(id));
  for (const id of fromOrder.filter((t) => wanted.includes(t))) out.splice(Math.min(fromOrder.indexOf(id), out.length), 0, id);
  return out;
}

export function withTreesFrom(target: BrowserState, source: BrowserState, extraTabs: Iterable<string> = []): BrowserState {
  const a = boundTrees(source);
  const b = boundTrees(target);
  const groupIds = new Set([...a.groups, ...b.groups]);
  const tabIds = new Set([...a.tabs, ...b.tabs, ...extraTabs]);
  for (const v of [...Object.values(source.splits), ...Object.values(target.splits)]) if (splitTabIds(v).some((t) => tabIds.has(t))) splitTabIds(v).forEach((t) => tabIds.add(t));
  for (const g of Object.values(source.groups)) if (g.tabIds.some((t) => tabIds.has(t))) groupIds.add(g.id);
  for (const g of Object.values(target.groups)) if (g.tabIds.some((t) => tabIds.has(t))) groupIds.add(g.id);
  if (!groupIds.size && !tabIds.size) return target;
  const tabs = withEntries<Tab>(target.tabs, source.tabs, tabIds);
  const groups = withEntries<TabGroup>(target.groups, source.groups, groupIds);
  const splitIds = [...Object.values(source.splits), ...Object.values(target.splits)].filter((v) => splitTabIds(v).some((t) => tabIds.has(t))).map((v) => v.id);
  const splits = withEntries(target.splits, source.splits, splitIds);
  const windows: Record<string, BrowserWindow> = { ...target.windows };
  for (const [id, w] of Object.entries(target.windows)) {
    const theirs = source.windows[id];
    const mine = [...tabIds].filter((t) => tabs[t]?.windowId === id);
    const tabOrder = placeIn(w.tabIds.filter((t) => !tabIds.has(t) || mine.includes(t)), mine, theirs?.tabIds ?? w.tabIds);
    const activeTabIds = { ...w.activeTabIds };
    for (const [profile, active] of Object.entries(w.activeTabIds)) if (!tabs[active] || !tabOrder.includes(active)) activeTabIds[profile] = theirs?.activeTabIds[profile] ?? tabOrder[0] ?? active;
    windows[id] = { ...w, tabIds: tabOrder, activeTabIds };
  }
  return { ...target, tabs, groups, splits, windows };
}
