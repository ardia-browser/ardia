import type { BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { changedIds } from "../browser/changes";
import { useBrowser } from "../browser/store";
import { holdsOpenTabs, regularOpenTab } from "./openTabsLocal";
import { spaceScope } from "./records";
import type { SyncDoc } from "./syncDoc";

const closedByUser = new Set<string>();

export const noteTabClosedByUser = (tabId: string) => void closedByUser.add(tabId);

export function openTabsClosed(next: BrowserState, prev: BrowserState): { spaceId: string; key: string }[] {
  if (next.tabs === prev.tabs) return [];
  const out: { spaceId: string; key: string }[] = [];
  let families: Set<string> | null = null;
  const alive = (spaceId: string, key: string) =>
    (families ??= new Set(Object.values(next.tabs).map((t) => `${t.spaceId}\u0001${pinKeyOf(t)}`))).has(`${spaceId}\u0001${key}`);
  const members = pinnedGroupMembers(prev.groups);
  for (const id of changedIds(next.tabs, prev.tabs)) {
    const was = prev.tabs[id];
    const now = next.tabs[id];
    const byUser = !now && closedByUser.delete(id);
    if (!was ||!next.spaces[was.spaceId]?.syncTabs || !regularOpenTab(prev, was, members)) continue;
    if (now && now.spaceId === was.spaceId && pinKeyOf(now) === pinKeyOf(was)) continue;
    const key = pinKeyOf(was);
    if (alive(was.spaceId, key)) continue;
    if (now || next.windows[was.windowId] || byUser || holdsOpenTabs(next, was.spaceId)) out.push({ spaceId: was.spaceId, key });
  }
  return out;
}

export function recordOpenTabCloses(doc: SyncDoc, closed: { spaceId: string; key: string }[]): boolean {
  let noted = false;
  for (const { spaceId, key } of closed) {
    const link = doc.spaces[spaceId];
    if (!link?.enabled) continue;
    const list = ((doc.tabCloses ??= {})[spaceScope(link.syncId)] ??= []);
    if (!list.includes(key)) list.push(key);
    noted = true;
  }
  return noted;
}

export function markOpenTabsSynced(doc: SyncDoc, spaceId: string, on: boolean) {
  useBrowser.getState().updateSpace(spaceId, { syncTabs: on || undefined });
  const link = doc.spaces[spaceId];
  if (link && on) delete link.tabsRetire;
  else if (link && doc.enabled) link.tabsRetire = true;
}
