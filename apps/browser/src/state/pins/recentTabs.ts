import type { BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile, viewTabIds } from "../browser/model";
import type { Tab } from "../browser/types";
import { dataIdOf } from "../profiles/profiles";
import type { Settings } from "../settings/settings";
import { CLEAN_UP_AFTER_MS } from "../settings/cleanUpAfter";
import { isAsleep } from "../tabs/pageSession";
import { isSwitchableTab } from "../tabs/switchOrder";

export function recentTabIds(s: BrowserState, windowId: string, now = Date.now(), staleAfterMs = CLEAN_UP_AFTER_MS): string[] {
  return orderedRecentTabs(s, windowId, viewTabIds(s, windowId))
    .filter((t, i) => i < 2 || now - t.lastActiveAt < staleAfterMs).map((t) => t.id);
}

function orderedRecentTabs(s: BrowserState, windowId: string, ids: string[]): Tab[] {
  const current = activeTabId(s, windowId);
  const open = ids.map((id) => s.tabs[id]!).filter((t) => !isAsleep(t) || t.id === current);
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
  return ordered;
}

export type TabSwitcherScope = Settings["tabSwitcherScope"];

export function switcherTabIds(s: BrowserState, windowId: string, scope: TabSwitcherScope): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const source = scope === "sharedData" ? s.profiles[w.profileId] : undefined;
  return w.tabIds.filter((id) => {
    const tab = s.tabs[id];
    if (!tab || tab.windowId !== windowId) return false;
    if (w.kind === "private") return tab.profileId === w.profileId;
    if (isIncognitoProfile(tab.profileId)) return false;
    if (tab.profileId === w.profileId) return true;
    if (scope === "currentProfile" || w.kind !== "main" || !Object.hasOwn(s.profiles, tab.profileId)) return false;
    return scope === "allProfiles" || (!!source && dataIdOf(s.profiles[tab.profileId]!) === dataIdOf(source));
  });
}

export function sessionTabIds(s: BrowserState, windowId: string, sessionStart: number, scope: TabSwitcherScope = "currentProfile"): string[] {
  const active = activeTabId(s, windowId);
  const now = Date.now();
  const recent = orderedRecentTabs(s, windowId, switcherTabIds(s, windowId, scope))
    .map((t) => t.id).filter((id) => id === active || isSwitchableTab(s, id));
  const fromSession = recent.filter((id) => id === active || s.tabs[id]!.lastActiveAt >= sessionStart || s.tabs[id]!.createdAt >= sessionStart);
  const fallback = recent.filter((id, index) => index < 2 || now - s.tabs[id]!.lastActiveAt < CLEAN_UP_AFTER_MS);
  return fromSession.length >= 2 ? fromSession : fallback;
}
