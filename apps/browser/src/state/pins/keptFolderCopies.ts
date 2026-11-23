import type { BrowserState } from "../browser/store";
import type { TabGroup } from "../browser/types";
import { pinnedGroupMembers } from "../browser/structure";
import { newId, pinKeyOf } from "../browser/model";
import { groupKeptOpen } from "../groups/closeGuard";
import { innermostGroupOf } from "../groups/groupNesting";
import { placeChoiceKey, tabChoiceKey } from "./pinChoices";

function withChoicesOfItsOwn(s: BrowserState, prev: BrowserState, profileId: string, key: string, ownKey: string): BrowserState {
  const choices = { ...s.pinChoices[profileId] };
  for (const choiceKey of [tabChoiceKey, placeChoiceKey]) {
    const was = prev.pinChoices[profileId]?.[choiceKey(key)];
    const now = choices[choiceKey(key)];
    if (now === was) continue;
    if (now) choices[choiceKey(ownKey)] = now;
    if (was) choices[choiceKey(key)] = was;
    else delete choices[choiceKey(key)];
  }
  const entries = { ...s.pinSync[profileId] };
  const entry = prev.pinSync[profileId]?.[key];
  if (entry) entries[key] = entry;
  return { ...s, pinChoices: { ...s.pinChoices, [profileId]: choices }, pinSync: entry ? { ...s.pinSync, [profileId]: entries } : s.pinSync };
}

function wasInFolder(s: BrowserState, prev: BrowserState, g: TabGroup, id: string): boolean {
  if (prev.groups[g.id]?.tabIds.includes(id)) return true;
  const key = pinKeyOf(s.tabs[id]!);
  const inner = innermostGroupOf(s.groups, id);
  return !!inner && !!prev.parkedPins[g.profileId]?.tabs.some((p) => p.id === key && p.groupId === pinKeyOf(inner));
}

export function apartFromKeptFolders(s: BrowserState, prev: BrowserState, windowId: string, profileId: string): BrowserState {
  const stayed = new Map<string, Set<string>>();
  for (const g of Object.values(s.groups)) {
    if (!g.pinned || g.parentId || g.windowId !== windowId || g.profileId !== profileId || !groupKeptOpen(g.id, s)) continue;
    const members = new Set(g.tabIds);
    for (const id of g.tabIds) if (s.tabs[id] && wasInFolder(s, prev, g, id)) stayed.set(pinKeyOf(s.tabs[id]!), members);
  }
  if (!stayed.size) return s;
  const pinnedMembers = pinnedGroupMembers(s.groups);
  let next = s;
  for (const id of s.windows[windowId]!.tabIds) {
    const t = s.tabs[id];
    if (t?.profileId !== profileId || (!t.pin && !pinnedMembers.has(id))) continue;
    const key = pinKeyOf(t);
    const folder = stayed.get(key);
    if (!folder || folder.has(id)) continue;
    const ownKey = newId("tab");
    next = withChoicesOfItsOwn({ ...next, tabs: { ...next.tabs, [id]: { ...t, pinKey: ownKey } } }, prev, profileId, key, ownKey);
  }
  return next;
}
