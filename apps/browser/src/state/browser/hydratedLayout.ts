import type { BrowserWindow, Profile, SplitView, Tab, TabGroup } from "./types";
import { isIncognitoProfile } from "./model";
import { pinHome } from "../pins/pinHomes";
import { DEFAULT_PROFILE } from "../profiles/profiles";
import { sanitizeSplits, splitTabIds } from "../splits/splits";
import { orderSections } from "../groups/groups";

type LayoutInput = {
  profiles?: Record<string, Profile>;
  windows?: Record<string, BrowserWindow>;
  windowOrder?: string[];
  tabs?: Record<string, Tab>;
  groups?: Record<string, TabGroup>;
  splits?: Record<string, SplitView>;
};

export function hydratedLayout(data: LayoutInput) {
  const profiles = data.profiles && Object.keys(data.profiles).length ? data.profiles : { [DEFAULT_PROFILE.id]: DEFAULT_PROFILE };
  const rawWindows = data.windows ?? {};
  const profileOk = (p: string) => Object.hasOwn(profiles, p) || isIncognitoProfile(p);
  const tabs: Record<string, Tab> = {};
  for (const t of Object.values(data.tabs ?? {})) {
    if (!Object.hasOwn(rawWindows, t.windowId) || !profileOk(t.profileId)) continue;
    tabs[t.id] = { ...t, pinnedUrl: t.pinnedUrl ?? pinHome(t, !!t.pin) };
  }
  let discarded = Object.keys(data.tabs ?? {}).length - Object.keys(tabs).length;
  const windows: Record<string, BrowserWindow> = {};
  for (const w of Object.values(rawWindows)) {
    const members = w.tabIds.filter((id) => Object.hasOwn(tabs, id) && tabs[id]!.windowId === w.id);
    discarded += w.tabIds.length - members.length;
    const tabIds = orderSections(members, tabs, data.groups ?? {});
    if (!tabIds.length) continue;
    const activeTabIds = Object.fromEntries(Object.entries(w.activeTabIds).filter(([p, id]) => Object.hasOwn(tabs, id) && tabs[id]!.profileId === p));
    const profileId = tabIds.some((id) => tabs[id]!.profileId === w.profileId) ? w.profileId : tabs[tabIds[0]!]!.profileId;
    activeTabIds[profileId] ??= tabIds.find((id) => tabs[id]!.profileId === profileId)!;
    windows[w.id] = { ...w, tabIds, profileId, activeTabIds };
  }
  discarded += Object.keys(rawWindows).length - Object.keys(windows).length;
  for (const t of Object.values(tabs)) {
    if (Object.hasOwn(windows, t.windowId)) continue;
    delete tabs[t.id];
    discarded++;
  }
  const windowOrder = [...(data.windowOrder ?? []).filter((id) => Object.hasOwn(windows, id)), ...Object.keys(windows).filter((id) => !data.windowOrder?.includes(id))];
  const inWindow = (id: string, windowId: string) => Object.hasOwn(tabs, id) && tabs[id]!.windowId === windowId;
  const kept = Object.values(data.groups ?? {}).map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => inWindow(id, g.windowId)) }));
  for (const [i, g] of Object.values(data.groups ?? {}).entries()) discarded += g.tabIds.length - kept[i]!.tabIds.length + (kept[i]!.tabIds.length ? 0 : 1);
  const groups = Object.fromEntries(kept.filter((g) => g.tabIds.length).map((g) => [g.id, g]));
  const splits = sanitizeSplits(data.splits ?? {}, tabs);
  const panes = (all: Record<string, SplitView>) => Object.values(all).reduce((sum, v) => sum + splitTabIds(v).length + 1, 0);
  discarded += panes(data.splits ?? {}) - panes(splits);
  return { profiles, windows, windowOrder, tabs, groups, splits, discarded };
}

export const layoutDrops = (data: LayoutInput): boolean => hydratedLayout(data).discarded > 0;
