import type { BrowserWindow, Space, SplitView, Tab, TabGroup } from "./types";
import { isIncognitoSpace } from "./model";
import { pinHome } from "../pins/pinHomes";
import { DEFAULT_SPACE } from "../spaces/spaces";
import { sanitizeSplits, splitTabIds } from "../splits/splits";
import { orderSections } from "../groups/groups";

type LayoutInput = {
  spaces?: Record<string, Space>;
  windows?: Record<string, BrowserWindow>;
  windowOrder?: string[];
  tabs?: Record<string, Tab>;
  groups?: Record<string, TabGroup>;
  splits?: Record<string, SplitView>;
};

export function hydratedLayout(data: LayoutInput) {
  const spaces = data.spaces && Object.keys(data.spaces).length ? data.spaces : { [DEFAULT_SPACE.id]: DEFAULT_SPACE };
  const rawWindows = data.windows ?? {};
  const spaceOk = (p: string) => !!spaces[p] || isIncognitoSpace(p);
  const tabs: Record<string, Tab> = {};
  for (const t of Object.values(data.tabs ?? {})) {
    if (!rawWindows[t.windowId] || !spaceOk(t.spaceId)) continue;
    tabs[t.id] = { ...t, pinnedUrl: t.pinnedUrl ?? pinHome(t, !!t.pin) };
  }
  let discarded = Object.keys(data.tabs ?? {}).length - Object.keys(tabs).length;
  const windows: Record<string, BrowserWindow> = {};
  for (const w of Object.values(rawWindows)) {
    const members = w.tabIds.filter((id) => tabs[id]?.windowId === w.id);
    discarded += w.tabIds.length - members.length;
    const tabIds = orderSections(members, tabs, data.groups ?? {});
    if (!tabIds.length) continue;
    const activeTabIds = Object.fromEntries(Object.entries(w.activeTabIds).filter(([p, id]) => tabs[id]?.spaceId === p));
    const spaceId = tabIds.some((id) => tabs[id]!.spaceId === w.spaceId) ? w.spaceId : tabs[tabIds[0]!]!.spaceId;
    activeTabIds[spaceId] ??= tabIds.find((id) => tabs[id]!.spaceId === spaceId)!;
    windows[w.id] = { ...w, tabIds, spaceId, activeTabIds };
  }
  discarded += Object.keys(rawWindows).length - Object.keys(windows).length;
  for (const t of Object.values(tabs)) {
    if (windows[t.windowId]) continue;
    delete tabs[t.id];
    discarded++;
  }
  const windowOrder = [...(data.windowOrder ?? []).filter((id) => windows[id]), ...Object.keys(windows).filter((id) => !data.windowOrder?.includes(id))];
  const inWindow = (id: string, windowId: string) => tabs[id]?.windowId === windowId;
  const kept = Object.values(data.groups ?? {}).map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => inWindow(id, g.windowId)) }));
  for (const [i, g] of Object.values(data.groups ?? {}).entries()) discarded += g.tabIds.length - kept[i]!.tabIds.length + (kept[i]!.tabIds.length ? 0 : 1);
  const groups = Object.fromEntries(kept.filter((g) => g.tabIds.length).map((g) => [g.id, g]));
  const splits = sanitizeSplits(data.splits ?? {}, tabs);
  const panes = (all: Record<string, SplitView>) => Object.values(all).reduce((sum, v) => sum + splitTabIds(v).length + 1, 0);
  discarded += panes(data.splits ?? {}) - panes(splits);
  return { spaces, windows, windowOrder, tabs, groups, splits, discarded };
}

export const layoutDrops = (data: LayoutInput): boolean => hydratedLayout(data).discarded > 0;
