import type { BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { changedIds } from "../browser/changes";
import { useBrowser } from "../browser/store";
import { holdsOpenTabs, regularOpenTab } from "./openTabsLocal";
import { profileScope } from "./records";
import type { SyncDoc } from "./syncDoc";

const closedByUser = new Set<string>();

export const noteTabClosedByUser = (tabId: string) => void closedByUser.add(tabId);

export function openTabsClosed(next: BrowserState, prev: BrowserState): { profileId: string; key: string }[] {
  if (next.tabs === prev.tabs) return [];
  const out: { profileId: string; key: string }[] = [];
  let families: Set<string> | null = null;
  const alive = (profileId: string, key: string) =>
    (families ??= new Set(Object.values(next.tabs).map((t) => `${t.profileId}\u0001${pinKeyOf(t)}`))).has(`${profileId}\u0001${key}`);
  const members = pinnedGroupMembers(prev.groups);
  for (const id of changedIds(next.tabs, prev.tabs)) {
    const was = prev.tabs[id];
    const now = next.tabs[id];
    const byUser = !now && closedByUser.delete(id);
    if (!was ||!next.profiles[was.profileId]?.syncTabs || !regularOpenTab(prev, was, members)) continue;
    if (now && now.profileId === was.profileId && pinKeyOf(now) === pinKeyOf(was)) continue;
    const key = pinKeyOf(was);
    if (alive(was.profileId, key)) continue;
    if (now || next.windows[was.windowId] || byUser || holdsOpenTabs(next, was.profileId)) out.push({ profileId: was.profileId, key });
  }
  return out;
}

export function recordOpenTabCloses(doc: SyncDoc, closed: { profileId: string; key: string }[]): boolean {
  let noted = false;
  for (const { profileId, key } of closed) {
    const link = doc.profiles[profileId];
    if (!link?.enabled) continue;
    const list = ((doc.tabCloses ??= {})[profileScope(link.syncId)] ??= []);
    if (!list.includes(key)) list.push(key);
    noted = true;
  }
  return noted;
}

export function markOpenTabsSynced(doc: SyncDoc, profileId: string, on: boolean) {
  useBrowser.getState().updateProfile(profileId, { syncTabs: on || undefined });
  const link = doc.profiles[profileId];
  if (link && on) delete link.tabsRetire;
  else if (link && doc.enabled) link.tabsRetire = true;
}
