import type { BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { ancestorIds, innermostGroupOf } from "../groups/groups";
import { isRegularWindow } from "../windows/small";
import { peekTabIds } from "../peek/peek";
import type { Tab, TabGroup } from "../browser/types";
import { syncsAsOpenTab } from "./openTabRecords";

type Members = ReadonlySet<string>;

const regularWindows = (s: BrowserState) => s.windowOrder.map((id) => s.windows[id]).filter(isRegularWindow);

export function regularOpenTab(s: BrowserState, t: Tab | undefined, pinnedMembers: Members = pinnedGroupMembers(s.groups)): t is Tab {
  return !!t && !t.pin && !t.liveItem && !pinnedMembers.has(t.id) && isRegularWindow(s.windows[t.windowId]) && !peekTabIds(s.peeks).has(t.id);
}

export const syncedOpenTab = (s: BrowserState, t: Tab | undefined, pinnedMembers: Members = pinnedGroupMembers(s.groups)): t is Tab =>
  regularOpenTab(s, t, pinnedMembers) && syncsAsOpenTab(t.url);

export const holdsOpenTabs = (s: BrowserState, profileId: string) =>
  Object.values(s.windows).some((w) => isRegularWindow(w) && (w.profileId === profileId || w.tabIds.some((id) => s.tabs[id]?.profileId === profileId)));

type LocalOpenTabs = { synced: { key: string; tab: Tab }[]; byKey: Map<string, Tab[]>; held: Set<string>; pinned: Set<string> };

export function localOpenTabs(s: BrowserState, profileId: string): LocalOpenTabs {
  const members = pinnedGroupMembers(s.groups);
  const held = new Set<string>();
  const pinned = new Set<string>();
  for (const t of Object.values(s.tabs)) {
    if (t.profileId !== profileId) continue;
    held.add(pinKeyOf(t));
    if (t.pin || members.has(t.id)) pinned.add(pinKeyOf(t));
  }
  for (const p of s.parkedPins[profileId]?.tabs ?? []) {
    held.add(p.id);
    pinned.add(p.id);
  }
  const synced: LocalOpenTabs["synced"] = [];
  const byKey = new Map<string, Tab[]>();
  for (const w of regularWindows(s)) {
    for (const id of w.tabIds) {
      const t = s.tabs[id];
      if (t?.profileId !== profileId || !syncedOpenTab(s, t, members) || pinned.has(pinKeyOf(t))) continue;
      const key = pinKeyOf(t);
      const copies = byKey.get(key);
      if (copies) copies.push(t);
      else {
        byKey.set(key, [t]);
        synced.push({ key, tab: t });
      }
    }
  }
  return { synced, byKey, held, pinned };
}

export function regularChain(groups: Record<string, TabGroup>, tabId: string): TabGroup[] {
  const inner = innermostGroupOf(groups, tabId);
  if (!inner || inner.pinned) return [];
  return [...ancestorIds(groups, inner.id).reverse().map((id) => groups[id]!), inner].filter((g) => !g.pinned);
}
