import type { BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { groupLabel } from "../pins/tabGrouping";
import { isOpenRegularWindow } from "../windows/small";

type GroupWorld = Pick<BrowserState, "groups" | "parkedPins" | "tabs">;

export type RouteGroup = { key: string; name: string };

const PARKED_GROUP_NAME = "Tab Group";

export function routeGroups(s: GroupWorld, profileId: string): RouteGroup[] {
  const seen = new Set<string>();
  const groups: RouteGroup[] = [];
  const live = Object.values(s.groups)
    .filter((g) => g.profileId === profileId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt);
  for (const g of live) {
    const key = pinKeyOf(g);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ key, name: groupLabel(s, g) });
  }
  for (const g of s.parkedPins[profileId]?.groups ?? []) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push({ key: g.id, name: g.name || PARKED_GROUP_NAME });
  }
  return groups;
}

export const routeTargetsStamp = (s: GroupWorld & Pick<BrowserState, "profiles" | "profileOrder">): string =>
  s.profileOrder
    .filter((id) => s.profiles[id])
    .map((id) => [`${id}=${s.profiles[id]!.name}`, ...routeGroups(s, id).map((g) => `${g.key}=${g.name}`)].join("\t"))
    .join("\n");

export const hasRouteGroup = (s: Pick<BrowserState, "groups" | "parkedPins">, profileId: string, key: string): boolean =>
  Object.values(s.groups).some((g) => g.profileId === profileId && pinKeyOf(g) === key) || !!s.parkedPins[profileId]?.groups.some((g) => g.id === key);

export function routeGroupName(s: GroupWorld, profileId: string, key: string): string | null {
  return routeGroups(s, profileId).find((g) => g.key === key)?.name ?? null;
}

export function groupWindow(s: BrowserState, profileId: string, key: string): string | undefined {
  const copies = Object.values(s.groups).filter((g) => g.profileId === profileId && pinKeyOf(g) === key && isOpenRegularWindow(s.windows[g.windowId]));
  const order = [...new Set([...s.ui.focusOrder, ...s.windowOrder])];
  return order.find((id) => copies.some((g) => g.windowId === id)) ?? copies[0]?.windowId;
}
