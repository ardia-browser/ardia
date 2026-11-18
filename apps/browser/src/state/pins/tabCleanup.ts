import type { StateCreator } from "zustand";
import type { BrowserState } from "../browser/store";
import { activeTabId, familyKeyOf, inPinnedContainer, isIncognitoProfile, pinSection, viewTabIds, without } from "../browser/model";
import { hasPage, isAsleep, navigationOf } from "../tabs/pageSession";
import { isSleeping } from "../tabs/sleepingTabs";
import { holderOf, isPageUnloaded } from "./pinShare";
import { splitOf, splitTabIds, splitTabIdsOf } from "../splits/splits";
import { lastUsedOf, restoredAtOf, sharedLastUsed, sharedRestoredAt } from "../tabs/tabShare";
import type { ClosedTab, Tab, TabGroup } from "../browser/types";
import { withoutFragment } from "../../lib/url";
import { tileFolderOf } from "./tileFolders";
import { syncGroupOrder, withParent } from "../groups/groups";
import { cleanedTabsFor, closedEntries, closeQuietly, keptCleanedTabs, regroupRestored, restoreSnapshots, restoreTarget } from "./closedTabs";
import { activated, apply, removeTabs } from "../tabs/tabs";

export type ClearedTabs = {
  windowId: string;
  entries: ClosedTab[];
  closedEntryIds: string[];
  tabIds: string[];
  groups: TabGroup[];
  fingerprint: string;
  profileId: string;
  remoteDeletions: number;
};

const remotePinDeletions = new Map<string, number>();

export function noteRemotePinDeletion(profileId: string) {
  remotePinDeletions.set(profileId, (remotePinDeletions.get(profileId) ?? 0) + 1);
}

export function unpinnedTabIds(s: BrowserState, windowId: string): string[] {
  return viewTabIds(s, windowId).filter((id) => !inPinnedContainer(s, id));
}

export function isClosedPin(s: BrowserState, id: string): boolean {
  const t = s.tabs[id];
  if (!t || !inPinnedContainer(s, id) || pinSection(t) === "tile") return false;
  return !hasPage(t) && activeTabId(s, t.windowId) !== id && !holderOf(s, id);
}

export function clearedTabIds(s: BrowserState, windowId: string): string[] {
  const ids = unpinnedTabIds(s, windowId);
  const active = activeTabId(s, windowId);
  const kept = new Set(ids.filter((id) => id === active || s.live[id]?.playingAudio));
  for (const id of [...kept]) splitTabIdsOf(splitOf(s, id))?.forEach((pane) => kept.add(pane));
  return ids.filter((id) => !kept.has(id));
}

export const CLEAN_UP_AFTER_MS = 12 * 60 * 60 * 1000;
export const MAX_CLEANED = 100;
export const HIDDEN_REPLACES_CLEANED_AFTER_MS = 24 * 60 * 60 * 1000;

function windowFingerprint(s: BrowserState, windowId: string): string {
  const w = s.windows[windowId];
  if (!w) return "";
  const inWindow = (id: string) => s.tabs[id]?.windowId === windowId;
  const tabs = w.tabIds.map((id) => {
    const t = s.tabs[id];
    return t ? [id, t.profileId, pinSection(t), tileFolderOf(t)?.id ?? ""].join(" ") : id;
  });
  const groups = Object.values(s.groups)
    .filter((g) => g.windowId === windowId)
    .map((g) => [g.id, g.parentId ?? "", g.pinned, g.tabIds.join(",")].join(" "))
    .sort();
  const splits = Object.values(s.splits)
    .filter((v) => splitTabIds(v).some(inWindow))
    .map((v) => splitTabIds(v).join(","))
    .sort();
  return [...tabs, "", ...groups, "", ...splits].join("\n");
}

export function undoable(before: BrowserState, after: BrowserState, windowId: string, profileId: string, entries: ClosedTab[]): ClearedTabs {
  return {
    windowId,
    entries,
    closedEntryIds: newClosedEntryIds(before, after),
    tabIds: before.windows[windowId]!.tabIds,
    groups: Object.values(before.groups).filter((g) => g.windowId === windowId),
    fingerprint: windowFingerprint(after, windowId),
    profileId,
    remoteDeletions: remotePinDeletions.get(profileId) ?? 0,
  };
}

export function canUndoClear(s: BrowserState, cleared: ClearedTabs): boolean {
  const closed = new Set(s.closedTabs.map((c) => c.id));
  return (
    (remotePinDeletions.get(cleared.profileId) ?? 0) === cleared.remoteDeletions &&
    cleared.closedEntryIds.every((id) => closed.has(id)) &&
    windowFingerprint(s, cleared.windowId) === cleared.fingerprint
  );
}

function newClosedEntryIds(before: BrowserState, after: BrowserState): string[] {
  return after.closedTabs.filter((c) => !before.closedTabs.includes(c)).map((c) => c.id);
}

const deselectedAt = new Map<string, number>();

export function noteDeselectedTabs(s: BrowserState, ids: readonly string[], at = Date.now()) {
  const open = new Set(Object.values(s.tabs).flatMap((t) => [t.id, familyKeyOf(t)]));
  for (const key of deselectedAt.keys()) if (!open.has(key)) deselectedAt.delete(key);
  const left = new Set(ids.flatMap((id) => (s.tabs[id] ? [familyKeyOf(s.tabs[id]!)] : [])));
  if (!left.size) return;
  for (const key of left) deselectedAt.set(key, at);
  for (const t of Object.values(s.tabs)) if (left.has(familyKeyOf(t))) deselectedAt.set(t.id, at);
}

function protectedFamilies(s: BrowserState): Set<string> {
  const showing = new Set(Object.values(s.windows).map((w) => w.profileId));
  const out = new Set<string>();
  for (const w of Object.values(s.windows)) {
    for (const [profileId, id] of Object.entries(w.activeTabIds)) {
      if (profileId !== w.profileId && showing.has(profileId)) continue;
      if (s.tabs[id]?.windowId === w.id) out.add(familyKeyOf(s.tabs[id]!));
    }
  }
  return out;
}

function lastUseOf(s: BrowserState) {
  const used = sharedLastUsed(s);
  const restored = sharedRestoredAt(s);
  const lastUsed = (t: Tab) => Math.max(lastUsedOf(used, t), deselectedAt.get(t.id) ?? 0, deselectedAt.get(familyKeyOf(t)) ?? 0, restoredAtOf(restored, t));
  return { used, restored, lastUsed };
}

function inactivity(s: BrowserState, windowId: string, profileId?: string) {
  const active = activeTabId(s, windowId, profileId);
  const grouped = new Set(Object.values(s.groups).flatMap((g) => g.tabIds));
  const inSplit = new Set(Object.values(s.splits).flatMap((v) => splitTabIds(v)));
  const kept = protectedFamilies(s);
  const keep = (t: Tab) => t.id === active || kept.has(familyKeyOf(t)) || inPinnedContainer(s, t.id) || s.live[t.id]?.playingAudio;
  const expires = (t: Tab) => !keep(t) && !grouped.has(t.id) && !inSplit.has(t.id);
  return { ...lastUseOf(s), active, inSplit, keep, expires };
}

function sweptView(s: BrowserState, windowId: string, profileId?: string): string[] {
  const view = viewTabIds(s, windowId, profileId);
  if (!profileId || profileId === s.windows[windowId]?.profileId) return view;
  const onScreen = new Set(Object.values(s.windows).flatMap((w) => viewTabIds(s, w.id).map((id) => familyKeyOf(s.tabs[id]!))));
  return view.filter((id) => !onScreen.has(familyKeyOf(s.tabs[id]!)));
}

export function cleanUpCandidates(s: BrowserState, windowId: string, inactiveForMs = CLEAN_UP_AFTER_MS, now = Date.now(), profileId?: string): string[] {
  const view = sweptView(s, windowId, profileId);
  const { active, inSplit, used, restored, keep, expires, lastUsed } = inactivity(s, windowId, profileId);
  const recency = (t: Tab) => Math.max(lastUsedOf(used, t), restoredAtOf(restored, t));
  const out = new Set<string>();
  const byPage = new Map<string, Tab[]>();
  for (const id of view) {
    const t = s.tabs[id]!;
    if (!t.url) continue;
    const key = withoutFragment(t.url);
    byPage.set(key, [...(byPage.get(key) ?? []), t]);
  }
  for (const same of byPage.values()) {
    if (same.length < 2) continue;
    const keeper = same.find((t) => t.pin) ?? same.find((t) => t.id === active) ?? [...same].sort((a, b) => recency(b) - recency(a))[0]!;
    for (const t of same) if (t !== keeper && !keep(t) && !inSplit.has(t.id)) out.add(t.id);
  }
  for (const id of view) {
    const t = s.tabs[id]!;
    if (expires(t) && now - lastUsed(t) >= inactiveForMs) out.add(id);
  }
  return view.filter((id) => out.has(id));
}

export function hiddenProfileIdsIn(s: BrowserState, windowId: string): string[] {
  const shown = s.windows[windowId]?.profileId;
  return [...new Set((s.windows[windowId]?.tabIds ?? []).flatMap((id) => s.tabs[id]?.profileId ?? []))].filter((id) => id !== shown);
}

export function hiddenCleanedRoom(s: BrowserState, windowId: string, now = Date.now()): number {
  const list = cleanedTabsFor(s, windowId);
  const young = list.findIndex((c) => now - c.closedAt < HIDDEN_REPLACES_CLEANED_AFTER_MS);
  return Math.max(0, MAX_CLEANED - list.length + (young === -1 ? list.length : young));
}

function hiddenCleanUpCandidates(s: BrowserState, windowId: string, inactiveForMs: number): string[] {
  const { lastUsed } = lastUseOf(s);
  const ids = hiddenProfileIdsIn(s, windowId).flatMap((profileId) => cleanUpCandidates(s, windowId, inactiveForMs, undefined, profileId));
  return ids.sort((a, b) => lastUsed(s.tabs[a]!) - lastUsed(s.tabs[b]!));
}

export function hiddenSweepLimits(s: BrowserState, inactiveForMs: number): Map<string, number> {
  const { lastUsed } = lastUseOf(s);
  const [room, limits, seen] = [new Map<string, number>(), new Map<string, number>(), new Set<string>()];
  const queue = s.windowOrder
    .flatMap((windowId) => hiddenCleanUpCandidates(s, windowId, inactiveForMs).map((id) => ({ windowId, tab: s.tabs[id]! })))
    .sort((a, b) => lastUsed(a.tab) - lastUsed(b.tab));
  for (const { windowId, tab } of queue) {
    if (seen.size === seen.add(familyKeyOf(tab)).size) continue;
    const list = s.windows[windowId]?.kind === "private" ? windowId : "";
    const left = room.get(list) ?? hiddenCleanedRoom(s, windowId);
    if (left <= 0) continue;
    room.set(list, left - 1);
    limits.set(windowId, (limits.get(windowId) ?? 0) + 1);
  }
  return limits;
}

export function nextCleanUpAt(s: BrowserState, windowId: string, inactiveForMs: number, profileId?: string, after = -Infinity): number {
  const { expires, lastUsed } = inactivity(s, windowId, profileId);
  let next = Infinity;
  for (const id of sweptView(s, windowId, profileId)) {
    const t = s.tabs[id]!;
    const at = lastUsed(t) + inactiveForMs;
    if (expires(t) && at > after) next = Math.min(next, at);
  }
  return next;
}

export function abandonedNewTabs(s: BrowserState, windowId: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const selected = new Set(Object.values(w.activeTabIds));
  const shown = w.activeTabIds[w.profileId];
  const out = w.tabIds.filter((id) => {
    const t = s.tabs[id];
    return !!t && t.windowId === w.id && !t.url && !hasPage(t) && !t.pin && id !== shown && !selected.has(id);
  });
  return out.length >= w.tabIds.length ? out.slice(0, w.tabIds.length - 1) : out;
}

export function switcherTabEligible(s: BrowserState, windowId: string, id: string): boolean {
  const tab = s.tabs[id];
  if (!tab) return false;
  const url = tab.url || navigationOf(tab)?.url;
  if (!url || url === "about:blank") return false;
  return id === activeTabId(s, windowId) || s.settings.sleepingTabsInSwitcher || !(isAsleep(tab) || isSleeping(id) || isPageUnloaded(s, id));
}

export function recentTabIds(s: BrowserState, windowId: string, now = Date.now(), staleAfterMs = CLEAN_UP_AFTER_MS): string[] {
  const current = activeTabId(s, windowId);
  const open = viewTabIds(s, windowId).filter((id) => switcherTabEligible(s, windowId, id)).map((id) => s.tabs[id]!);
  const available = new Map(open.map((t) => [t.id, t]));
  const place = new Map(open.map((t, i) => [t.id, i]));
  const newer = (a: Tab, b: Tab) => b.createdAt - a.createdAt || place.get(b.id)! - place.get(a.id)!;
  const children = new Map<string, Tab[]>();
  const loose: Tab[] = [];
  for (const t of open) {
    if (t.id === current || !t.unseen) continue;
    const parent = t.openerId && t.openerId !== t.id ? available.get(t.openerId) : undefined;
    if (!parent) {
      loose.push(t);
      continue;
    }
    children.set(parent.id, [...(children.get(parent.id) ?? []), t]);
  }
  for (const tabs of children.values()) tabs.sort(newer);
  loose.sort(newer);
  const recent = open.filter((t) => t.id !== current && !t.unseen).sort((a, b) => b.lastActiveAt - a.lastActiveAt || newer(a, b));
  const ordered: Tab[] = [];
  const seen = new Set<string>();
  const append = (root: Tab) => {
    const stack = [root];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      ordered.push(t);
      const next = children.get(t.id) ?? [];
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
  };
  const active = current ? available.get(current) : undefined;
  if (active) append(active);
  for (const t of recent) append(t);
  for (const t of loose) append(t);
  for (const t of [...open].sort(newer)) append(t);
  return ordered.filter((t, i) => i < 2 || now - t.lastActiveAt < staleAfterMs).map((t) => t.id);
}

export function sessionTabIds(s: BrowserState, windowId: string, sessionStart: number): string[] {
  const visible = (ids: string[]) => ids.filter((id) => switcherTabEligible(s, windowId, id));
  const now = Date.now();
  const recent = visible(recentTabIds(s, windowId, now, Infinity));
  const active = activeTabId(s, windowId);
  const fromSession = recent.filter((id) => id === active || s.tabs[id]!.lastActiveAt >= sessionStart || s.tabs[id]!.createdAt >= sessionStart);
  const fallback = recent.filter((id, index) => index < 2 || now - s.tabs[id]!.lastActiveAt < CLEAN_UP_AFTER_MS);
  return fromSession.length >= 2 ? fromSession : fallback;
}

const addCleanedBatch = (list: ClosedTab[], batch: ClosedTab[]) =>
  [...keptCleanedTabs(list), ...batch].slice(-Math.max(MAX_CLEANED, batch.length));

export type CleanUpSlice = {
  cleanedTabs: ClosedTab[];
  privateCleanedTabs: Record<string, ClosedTab[]>;
  cleanUpTabs(windowId: string, options?: { inactiveForMs?: number; allProfiles?: boolean; hiddenProfilesUpTo?: number }): number;
  restoreCleaned(entryIds?: string | string[], windowId?: string): void;
  clearUnpinnedTabs(windowId: string): ClearedTabs | null;
  undoClearTabs(cleared: ClearedTabs): void;
  removeClosedPin(id: string): ClearedTabs | null;
  closeAbandonedNewTabs(): void;
};
export function forgetClosedWindowCleanUps(s: BrowserState, prev: BrowserState): Pick<BrowserState, "privateCleanedTabs"> | null {
  if (s.windows === prev.windows) return null;
  const gone = Object.keys(s.privateCleanedTabs).filter((id) => !s.windows[id]);
  return gone.length ? { privateCleanedTabs: without(s.privateCleanedTabs, gone) } : null;
}
export const createCleanUpSlice: StateCreator<BrowserState, [], [], CleanUpSlice> = (set, get) => ({
  cleanedTabs: [],
  privateCleanedTabs: {},
  cleanUpTabs(windowId, options = {}) {
    const s = get();
    const minutes = s.settings.cleanUpInactiveTabsAfterMinutes;
    const after = options.inactiveForMs ?? (minutes ? minutes * 60_000 : CLEAN_UP_AFTER_MS);
    const onlyHidden = options.hiddenProfilesUpTo !== undefined;
    const shown = onlyHidden ? [] : cleanUpCandidates(s, windowId, after);
    const limit = Math.max(0, options.hiddenProfilesUpTo ?? hiddenCleanedRoom(s, windowId) - shown.length);
    const hidden = onlyHidden || options.allProfiles ? hiddenCleanUpCandidates(s, windowId, after).slice(0, limit) : [];
    const ids = [...shown, ...hidden];
    if (!ids.length) return 0;
    const entries = closedEntries(s, ids);
    const next = closeQuietly(s, ids);
    if (s.windows[windowId]?.kind === "private") {
      const own = addCleanedBatch(next.privateCleanedTabs[windowId] ?? [], entries);
      set({ ...next, privateCleanedTabs: { ...next.privateCleanedTabs, [windowId]: own } });
    } else {
      set({ ...next, cleanedTabs: addCleanedBatch(next.cleanedTabs, entries) });
    }
    return ids.length;
  },
  restoreCleaned(entryIds, fromWindowId) {
    const s = get();
    const wanted = entryIds === undefined ? null : new Set([entryIds].flat());
    const privateId = fromWindowId && s.windows[fromWindowId]?.kind === "private"
      ? fromWindowId
      : Object.keys(s.privateCleanedTabs).find((id) => !!wanted && s.privateCleanedTabs[id]!.some((c) => wanted.has(c.id)));
    const list = keptCleanedTabs(privateId ? (s.privateCleanedTabs[privateId] ?? []) : s.cleanedTabs);
    const entries = list.filter((c) => !wanted || wanted.has(c.id));
    if (!entries.length) return;
    const left = list.filter((c) => !entries.includes(c));
    let next: BrowserState = privateId
      ? { ...s, privateCleanedTabs: { ...s.privateCleanedTabs, [privateId]: left } }
      : { ...s, cleanedTabs: left };
    for (const e of entries) {
      const windowId = privateId ? (next.windows[privateId]?.kind === "private" ? privateId : undefined) : restoreTarget(next, e.windowId);
      if (!windowId || (isIncognitoProfile(e.tab.profileId) && e.windowId !== windowId)) continue;
      const [restored, [id]] = restoreSnapshots(next, windowId, [{ tab: e.tab, tabId: e.restoreFrom ?? e.tabId, index: windowId === e.windowId ? e.index : undefined }]);
      next = restored;
      if (id && e.group) next = regroupRestored(next, windowId, [e], [id]);
      if (id && typeof entryIds === "string") next = apply(next, activated(next, id));
    }
    set(next);
  },
  clearUnpinnedTabs(windowId) {
    const s = get();
    const ids = clearedTabIds(s, windowId);
    if (!ids.length) return null;
    const entries = closedEntries(s, ids);
    get().closeTabs(ids);
    return undoable(s, get(), windowId, s.windows[windowId]!.profileId, entries);
  },
  undoClearTabs(cleared) {
    const s = get();
    if (!canUndoClear(s, cleared)) return;
    const { windowId, entries } = cleared;
    const undone = new Set(cleared.closedEntryIds);
    const [restored, ids] = restoreSnapshots(
      { ...s, closedTabs: s.closedTabs.filter((c) => !undone.has(c.id)) },
      windowId,
      entries.map((e) => ({ tab: e.tab, tabId: e.restoreFrom ?? e.tabId })),
    );
    const renamed = new Map(entries.map((e, i) => [e.tabId, ids[i]]));
    const now = (id: string) => renamed.get(id) ?? id;
    const back = cleared.tabIds.map(now).filter((id) => restored.tabs[id]?.windowId === windowId);
    const w = restored.windows[windowId]!;
    const window = { ...w, tabIds: [...back, ...w.tabIds.filter((id) => !back.includes(id))] };
    const groups = Object.fromEntries(Object.entries(restored.groups).filter(([, g]) => g.windowId !== windowId));
    for (const g of cleared.groups) {
      const tabIds = g.tabIds.map(now).filter((id) => restored.tabs[id]);
      const current = restored.groups[g.id];
      groups[g.id] = current ? withParent({ ...current, pinned: g.pinned, tabIds }, g.parentId) : { ...g, tabIds };
    }
    const closedTabs = restored.closedTabs.map((c) => {
      const moved = c.tabId ? renamed.get(c.tabId) : undefined;
      return moved ? { ...c, tabId: moved, restoreFrom: c.restoreFrom ?? c.tabId } : c;
    });
    set({ ...restored, closedTabs, groups: syncGroupOrder(groups, window), windows: { ...restored.windows, [windowId]: window } });
  },
  removeClosedPin(id) {
    const s = get();
    if (!isClosedPin(s, id)) return null;
    const windowId = s.tabs[id]!.windowId;
    set(removeTabs(s, [id], true));
    const after = get();
    return undoable(s, after, windowId, s.tabs[id]!.profileId, after.closedTabs.filter((c) => !s.closedTabs.includes(c)));
  },
  closeAbandonedNewTabs() {
    const s = get();
    const abandoned = Object.values(s.windows).flatMap((w) => abandonedNewTabs(s, w.id));
    if (abandoned.length) set(removeTabs(s, abandoned, false));
  },
});
