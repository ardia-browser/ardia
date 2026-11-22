import { useBrowser, type BrowserState } from "../browser/store";
import { makeTab, newId, pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { orderSections, placeGroups, reparent, syncGroupOrder, withParent } from "../groups/groups";
import { fromSync } from "../pins/pinOrderChoices";
import { removeTabs, withNewTab } from "../tabs/tabs";
import { IDLE, withWake } from "../tabs/pageSession";
import type { Tab, TabGroup } from "../browser/types";
import { noteOpenTabsApplied } from "../telemetry/openTabSyncCounts";
import { homeWindow, openWindows } from "./pinnedSyncState";
import { localOpenTabs, syncedOpenTab } from "./openTabsLocal";
import { OPEN_GROUP, OPEN_TAB, openGroupValue, openTabValue, type OpenGroupValue, type OpenTabValue } from "./openTabRecords";

const store = () => useBrowser.getState();
const MAX_GROUP_DEPTH = 32;

const order = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);
const sameList = (a: readonly string[], z: readonly string[]) => a.length === z.length && a.every((x, i) => x === z[i]);

function synced(t: Tab, v: OpenTabValue): Tab {
  const unloaded = t.page.kind === "idle" || t.page.kind === "asleep";
  let next = t;
  if (unloaded && t.url !== v.u) next = { ...next, url: v.u, title: v.t, page: withWake(next.page, undefined) };
  else if (unloaded && t.title !== v.t) next = { ...next, title: v.t };
  if (v.a > next.lastActiveAt) next = { ...next, lastActiveAt: v.a };
  return next;
}

function arrange(s: BrowserState, profileId: string, tabValues: Map<string, OpenTabValue>, groupValues: Map<string, OpenGroupValue>): BrowserState {
  const members = pinnedGroupMembers(s.groups);
  const chainOf = (group: string | null): string[] => {
    const out: string[] = [];
    for (let at = group; at && groupValues.has(at) && !out.includes(at) && out.length < MAX_GROUP_DEPTH; at = groupValues.get(at)!.p) out.unshift(at);
    return out;
  };
  const before = s.groups;
  let groups: Record<string, TabGroup> = { ...s.groups };
  const windows = { ...s.windows };
  const touched: string[] = [];
  let edited = false;
  for (const w of openWindows(s)) {
    const ranked = w.tabIds.filter((id) => {
      const t = s.tabs[id];
      return t?.profileId === profileId && syncedOpenTab(s, t, members) && tabValues.has(pinKeyOf(t));
    });
    if (!ranked.length) continue;
    const valueOf = (id: string) => tabValues.get(pinKeyOf(s.tabs[id]!))!;
    const sorted = [...ranked].sort((a, z) => order(valueOf(a).pos, valueOf(z).pos) || order(pinKeyOf(s.tabs[a]!), pinKeyOf(s.tabs[z]!)));
    const rankedSet = new Set(ranked);
    let slot = 0;
    const tabIds = w.tabIds.map((id) => (rankedSet.has(id) ? sorted[slot++]! : id));
    const local = Object.values(groups).filter((g) => g.windowId === w.id && g.profileId === profileId && !g.pinned);
    const idOfKey = new Map(local.map((g) => [pinKeyOf(g), g.id]));
    const wanted = new Map<string, string[]>();
    for (const id of sorted) for (const key of chainOf(valueOf(id).g)) wanted.set(key, [...(wanted.get(key) ?? []), id]);
    for (const g of local) {
      const key = pinKeyOf(g);
      const ids = [...g.tabIds.filter((id) => !rankedSet.has(id)), ...(wanted.get(key) ?? [])];
      const look = wanted.has(key) ? groupValues.get(key) : undefined;
      const restyled = !!look && (look.n !== g.name || look.i !== g.icon || look.c !== g.color);
      if (!ids.length) {
        delete groups[g.id];
        edited = true;
      } else if (restyled || !sameList([...ids].sort(), [...g.tabIds].sort())) {
        groups[g.id] = { ...g, tabIds: ids, ...(look ? { name: look.n, icon: look.i, color: look.c } : {}) };
        edited = true;
      }
    }
    for (const [key, ids] of wanted) {
      if (idOfKey.has(key)) continue;
      const look = groupValues.get(key)!;
      const id = groups[key] || before[key] ? newId("g") : key;
      groups[id] = { id, ...(id !== key ? { pinKey: key } : {}), windowId: w.id, profileId, name: look.n, icon: look.i, color: look.c, collapsed: false, pinned: false, tabIds: ids, createdAt: Date.now() };
      idOfKey.set(key, id);
      edited = true;
    }
    for (const key of wanted.keys()) {
      const id = idOfKey.get(key)!;
      const parentKey = groupValues.get(key)!.p;
      const parent = parentKey && wanted.has(parentKey) ? idOfKey.get(parentKey) : undefined;
      if (groups[id] && groups[id]!.parentId !== parent) {
        groups[id] = withParent(groups[id]!, parent);
        edited = true;
      }
    }
    if (!sameList(tabIds, w.tabIds)) {
      windows[w.id] = { ...w, tabIds };
      edited = true;
    }
    touched.push(w.id);
  }
  if (!edited) return s;
  groups = reparent(groups, before);
  for (const id of touched) {
    const w = windows[id]!;
    const tabIds = orderSections(placeGroups(w.tabIds, groups, id), s.tabs, groups);
    const window = sameList(tabIds, w.tabIds) ? w : { ...w, tabIds };
    windows[id] = window;
    groups = syncGroupOrder(groups, window);
  }
  return { ...s, windows, groups };
}

export function applyOpenTabs(profileId: string, visible: Map<string, unknown>, changed: Set<string>, closed: Set<string>, seen: Map<string, string>): boolean {
  const s = store();
  const home = homeWindow(s, profileId);
  if (!home) return false;
  const tabValues = new Map<string, OpenTabValue>();
  const groupValues = new Map<string, OpenGroupValue>();
  for (const [k, v] of visible) {
    if (k.startsWith(OPEN_TAB)) {
      const value = openTabValue(v);
      if (value) tabValues.set(k.slice(OPEN_TAB.length), value);
    } else if (k.startsWith(OPEN_GROUP)) {
      const value = openGroupValue(v);
      if (value) groupValues.set(k.slice(OPEN_GROUP.length), value);
    }
  }
  const local = localOpenTabs(s, profileId);
  const changedTabs = [...changed].filter((k) => k.startsWith(OPEN_TAB)).map((k) => k.slice(OPEN_TAB.length));
  let tabs = s.tabs;
  const put = (t: Tab) => {
    if (tabs === s.tabs) tabs = { ...s.tabs };
    tabs[t.id] = t;
  };
  const homeTabs = [...home.tabIds];
  let opened = 0;
  let updated = 0;
  for (const key of changedTabs) {
    const v = tabValues.get(key);
    if (!v) continue;
    const here = local.byKey.get(key);
    if (here) {
      for (const t of here) {
        const next = synced(t, v);
        if (next === t) continue;
        put(next);
        if (next.url !== t.url) seen.set(key, next.url);
        updated++;
      }
      continue;
    }
    if (local.held.has(key) || closed.has(key)) continue;
    const id = tabs[key] ? newId("tab") : key;
    put({ ...makeTab(home.id, profileId, v.u, { title: v.t }), id, ...(id !== key ? { pinKey: key } : {}), page: IDLE, lastActiveAt: v.a || Date.now() });
    homeTabs.push(id);
    seen.set(key, v.u);
    opened++;
  }
  const gone = changedTabs.filter((key) => !tabValues.has(key)).flatMap((key) => (local.byKey.get(key) ?? []).map((t) => t.id));
  let next: BrowserState = { ...s, tabs, windows: opened ? { ...s.windows, [home.id]: { ...home, tabIds: homeTabs } } : s.windows };
  if (gone.length) {
    const leaving = new Set(gone);
    for (const w of Object.values(next.windows)) if (w.tabIds.length && w.tabIds.every((id) => leaving.has(id))) [next] = withNewTab(next, w.id, { profileId });
    next = removeTabs(next, gone, false);
  }
  if (changed.size) next = arrange(next, profileId, tabValues, groupValues);
  noteOpenTabsApplied({ opened, closed: gone.length, updated });
  if (next.tabs === s.tabs && next.windows === s.windows && next.groups === s.groups) return true;
  const { windows, groups, find, splits, selection, windowOrder, windowUi } = next;
  fromSync(() => useBrowser.setState({ tabs: next.tabs, windows, groups, find, splits, selection, windowOrder, windowUi }));
  return true;
}
