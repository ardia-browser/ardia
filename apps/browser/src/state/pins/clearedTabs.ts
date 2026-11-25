import type { BrowserState } from "../browser/store";
import { activeTabId, inPinnedContainer, pinSection, viewTabIds } from "../browser/model";
import type { ClosedTab, SplitView, Tab, TabGroup } from "../browser/types";
import { splitOf, splitTabIds, splitTabIdsOf, withPaneIds } from "../splits/splits";
import { hasPage } from "../tabs/pageSession";
import { shownLiveOf } from "../tabs/tabLive";
import { tileFolderOf } from "./tileFolders";
import { closedTabEntry } from "./closedTabs";

export type ClearedTabs = {
  windowId: string;
  entries: ClosedTab[];
  closedEntryIds: string[];
  tabIds: string[];
  tabIndexes: number[];
  groups: TabGroup[];
  fingerprint: string;
  profileId: string;
  remoteDeletions: number;
  selectedTabId?: string;
  blankTabIds?: string[];
  splits?: SplitView[];
  blankPanes?: ClosedTab[];
  liveItems?: Record<string, NonNullable<Tab["liveItem"]>>;
};

const remotePinDeletions = new Map<string, number>();

export function noteRemotePinDeletion(profileId: string) {
  remotePinDeletions.set(profileId, (remotePinDeletions.get(profileId) ?? 0) + 1);
}

export const unpinnedTabIds = (s: BrowserState, windowId: string): string[] => viewTabIds(s, windowId).filter((id) => !inPinnedContainer(s, id));

function withSplitPanes(s: BrowserState, ids: string[]): Set<string> {
  const out = new Set(ids);
  for (const id of ids) splitTabIdsOf(splitOf(s, id))?.forEach((pane) => out.add(pane));
  return out;
}

export function clearedTabIds(s: BrowserState, windowId: string): string[] {
  const all = viewTabIds(s, windowId);
  const ids = all.filter((id) => !inPinnedContainer(s, id));
  const active = activeTabId(s, windowId);
  const playing = (id: string) => !!shownLiveOf(s, id).playingAudio;
  const kept = withSplitPanes(s, all.filter((id) => id === active || playing(id)));
  const cleared = ids.filter((id) => !kept.has(id));
  if (cleared.length) return cleared;
  if (!active || !ids.includes(active)) return [];
  const stillPlaying = withSplitPanes(s, all.filter(playing));
  const selected = ids.filter((id) => !stillPlaying.has(id));
  return selected.every((id) => isBlankTab(s, id)) ? [] : selected;
}

function isBlankTab(s: BrowserState, id: string): boolean {
  const t = s.tabs[id];
  return !!t && !t.url && !hasPage(t) && !splitOf(s, id);
}

export function blankSplitPanes(s: BrowserState, ids: string[]): ClosedTab[] {
  const now = Date.now();
  return ids
    .map((id) => s.tabs[id])
    .filter((t): t is NonNullable<typeof t> => !!t && !t.url && !!splitOf(s, t.id))
    .map((t) => closedTabEntry(s, t, { windowId: t.windowId, index: s.windows[t.windowId]?.tabIds.indexOf(t.id) ?? 0 }, now));
}

function windowFingerprint(s: BrowserState, windowId: string, profileId: string): string {
  const w = s.windows[windowId];
  if (!w) return "";
  const inWindow = (id: string) => s.tabs[id]?.windowId === windowId && s.tabs[id]?.profileId === profileId;
  const tabs = w.tabIds.filter((id) => !s.tabs[id] || s.tabs[id]!.profileId === profileId).map((id) => {
    const t = s.tabs[id];
    return t ? [id, pinSection(t), tileFolderOf(t)?.id ?? ""].join(" ") : id;
  });
  const groups = Object.values(s.groups)
    .filter((g) => g.windowId === windowId && g.profileId === profileId)
    .map((g) => [g.id, g.parentId ?? "", g.pinned, g.tabIds.join(",")].join(" "))
    .sort();
  const splits = Object.values(s.splits)
    .filter((v) => splitTabIds(v).some(inWindow))
    .map((v) => [v.id, v.orientation, JSON.stringify(v.slots)].join(" "))
    .sort();
  return [...tabs, "", ...groups, "", ...splits].join("\n");
}

export function undoable(before: BrowserState, after: BrowserState, windowId: string, profileId: string, entries: ClosedTab[], blankPanes: ClosedTab[] = []): ClearedTabs {
  const tabIds: string[] = [];
  const tabIndexes: number[] = [];
  before.windows[windowId]!.tabIds.forEach((id, index) => {
    if (before.tabs[id]?.profileId === profileId) {
      tabIds.push(id);
      tabIndexes.push(index);
    }
  });
  const allEntries = [...entries, ...blankPanes];
  const liveItems = clearedLiveItems(before, allEntries);
  return {
    windowId,
    entries,
    closedEntryIds: newClosedEntryIds(before, after),
    tabIds,
    tabIndexes,
    groups: Object.values(before.groups).filter((g) => g.windowId === windowId && g.profileId === profileId),
    fingerprint: windowFingerprint(after, windowId, profileId),
    profileId,
    remoteDeletions: remotePinDeletions.get(profileId) ?? 0,
    selectedTabId: selectedAmong(before, windowId, allEntries),
    blankTabIds: (after.windows[windowId]?.tabIds ?? []).filter((id) => !before.tabs[id]),
    splits: clearedSplits(before, allEntries),
    ...(blankPanes.length ? { blankPanes } : {}),
    ...(liveItems ? { liveItems } : {}),
  };
}

function clearedLiveItems(before: BrowserState, entries: ClosedTab[]): Record<string, NonNullable<Tab["liveItem"]>> | undefined {
  const out: Record<string, NonNullable<Tab["liveItem"]>> = {};
  for (const e of entries) {
    if (!e.tabId) continue;
    const item = before.tabs[e.tabId]?.liveItem;
    if (item) out[e.tabId] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function clearedSplits(before: BrowserState, entries: ClosedTab[]): SplitView[] {
  const closed = new Set(entries.map((e) => e.tabId));
  return Object.values(before.splits).filter((v) => splitTabIds(v).some((id) => closed.has(id)));
}

export function rejoinedSplits(s: BrowserState, cleared: ClearedTabs, renamed: (id: string) => string): BrowserState["splits"] {
  let splits = s.splits;
  for (const split of cleared.splits ?? []) {
    const panes = splitTabIds(split).map(renamed);
    const placed = panes.every((id) => s.tabs[id]?.windowId === cleared.windowId && (splitOf({ splits }, id)?.id ?? split.id) === split.id);
    const survivor = splits[split.id];
    if (!placed || (survivor && !splitTabIds(survivor).every((id) => panes.includes(id)))) continue;
    splits = { ...splits, [split.id]: withPaneIds(split, panes) };
  }
  return splits;
}

function selectedAmong(s: BrowserState, windowId: string, entries: ClosedTab[]): string | undefined {
  const active = activeTabId(s, windowId);
  return active && entries.some((e) => e.tabId === active) ? active : undefined;
}

export function canUndoClear(s: BrowserState, cleared: ClearedTabs): boolean {
  const closed = new Set(s.closedTabs.map((c) => c.id));
  return (
    (remotePinDeletions.get(cleared.profileId) ?? 0) === cleared.remoteDeletions &&
    cleared.closedEntryIds.every((id) => closed.has(id)) &&
    windowFingerprint(s, cleared.windowId, cleared.profileId) === cleared.fingerprint
  );
}

function newClosedEntryIds(before: BrowserState, after: BrowserState): string[] {
  return after.closedTabs.filter((c) => !before.closedTabs.includes(c)).map((c) => c.id);
}
