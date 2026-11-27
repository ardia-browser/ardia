import type { BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { numberedTabs } from "../sidebar/entries";
import { isPageUnloaded } from "../pins/pinShare";
import { isAsleep } from "./pageSession";
import { isSleeping } from "./sleepingTabs";

export function isSwitchableTab(s: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  return !!tab && !isAsleep(tab) && !isSleeping(id) && !isPageUnloaded(s, id);
}

function collapsedOwners(s: BrowserState, windowId: string): Map<string, string> {
  const owners = new Map<string, string>();
  const collapsedAbove = (parentId: string | null | undefined): boolean => {
    for (let parent = parentId ? s.groups[parentId] : undefined; parent; parent = parent.parentId ? s.groups[parent.parentId] : undefined) if (parent.collapsed) return true;
    return false;
  };
  for (const group of Object.values(s.groups)) {
    if (group.windowId !== windowId || !group.collapsed || collapsedAbove(group.parentId)) continue;
    for (const id of group.tabIds) owners.set(id, group.id);
  }
  return owners;
}

export function inOrderTabIds(s: BrowserState, windowId: string): string[] {
  const active = activeTabId(s, windowId);
  const eligible = (id: string) => id === active || isSwitchableTab(s, id);
  const owners = collapsedOwners(s, windowId);
  const newest = (groupId: string) =>
    s.groups[groupId]!.tabIds.filter((id) => owners.get(id) === groupId && eligible(id)).reduce<string | undefined>((a, b) => (!a || s.tabs[b]!.lastActiveAt > s.tabs[a]!.lastActiveAt ? b : a), undefined);
  const stops: string[] = [];
  const groupsSeen = new Set<string>();
  for (const id of numberedTabs(s, windowId, eligible)) {
    if (!eligible(id) || stops.includes(id)) continue;
    const owner = owners.get(id);
    if (!owner) {
      stops.push(id);
      continue;
    }
    if (groupsSeen.has(owner)) continue;
    groupsSeen.add(owner);
    const stop = active && owners.get(active) === owner ? active : newest(owner);
    if (stop && !stops.includes(stop)) stops.push(stop);
  }
  return stops;
}

export function stepFrom(ids: readonly string[], from: string | undefined, delta: 1 | -1): number {
  const at = from ? ids.indexOf(from) : -1;
  if (at < 0) return delta > 0 ? 0 : ids.length - 1;
  return (at + delta + ids.length) % ids.length;
}

export function steppedTabId(s: BrowserState, windowId: string, delta: 1 | -1): string | undefined {
  const ids = inOrderTabIds(s, windowId);
  const active = activeTabId(s, windowId);
  const next = ids[stepFrom(ids, active, delta)];
  return next && next !== active ? next : undefined;
}
