import type { BrowserState } from "../browser/store";
import type { Tab, TabGroup } from "../browser/types";
import { inPinnedContainer, newId, pinKeyOf } from "../browser/model";
import { adoptOf, hasPage, holderOfPage, wakeOf } from "../tabs/pageSession";
import { splitTabIds } from "../splits/splits";
import { isRegularWindow } from "../windows/small";
import { keepShownProfile, swapPlaces } from "../tabs/tabShare";
import { removeTabs } from "../tabs/tabs";
import { nestGroups, orderSections, syncGroupOrder, withParent } from "./groups";
import { movingGroupHere } from "../pins/tabGrouping";

export const keepUngroupedTabs = (s: BrowserState, homeId: string, members: Set<string>): BrowserState =>
  keepSameTabRows(keepOwnAddresses(keepSplitsHome(s, homeId, members), homeId, members), members);

function unpinnedMirrors(before: BrowserState, after: BrowserState, groupId: string) {
  const g = before.groups[groupId];
  const w = g && before.windows[g.windowId];
  if (!g?.pinned || after.groups[groupId]?.pinned !== false || !before.settings.shareTabsAcrossWindows || !isRegularWindow(w)) return [];
  return Object.values(before.groups).filter((x) => x.id !== groupId && x.pinned && x.profileId === g.profileId && pinKeyOf(x) === pinKeyOf(g) && isRegularWindow(before.windows[x.windowId]));
}

export const unpinsMirrors = (before: BrowserState, after: BrowserState, groupId: string) => unpinnedMirrors(before, after, groupId).length > 0;

export function withMirrorsUnpinned(before: BrowserState, after: BrowserState, groupId: string): BrowserState {
  const mirrors = unpinnedMirrors(before, after, groupId);
  if (!mirrors.length) return after;
  const g = after.groups[groupId]!;
  const block = new Set(g.tabIds);
  const ids = after.windows[g.windowId]?.tabIds ?? [];
  const end = ids.reduce((last, id, i) => (block.has(id) ? i : last), -1);
  const followers = ids.slice(end + 1).map((id) => after.tabs[id]).filter((t): t is Tab => !!t && t.profileId === g.profileId && !t.pin && !inPinnedContainer(after, t.id));
  const parent = g.parentId ? after.groups[g.parentId] : undefined;
  let next = after;
  for (const m of mirrors) {
    const own = next.groups[m.id];
    if (!own) continue;
    let parentId: string | null = null;
    if (parent) [next, parentId] = withCounterpart(next, parent, m.windowId);
    const there = (next.windows[m.windowId]?.tabIds ?? []).filter((id) => !own.tabIds.includes(id) && next.tabs[id]?.profileId === m.profileId);
    const beforeId = followers.map((f) => there.find((id) => pinKeyOf(next.tabs[id]!) === pinKeyOf(f))).find(Boolean) ?? null;
    const moved = [{ pinned: false, parentId, beforeId }, { pinned: false, parentId, beforeId: null }, { pinned: false, parentId: null, beforeId: null }]
      .map((p) => movingGroupHere(next, m.id, p))
      .find((x) => Object.keys(x).length);
    next = moved ? { ...next, ...moved } : withUnpinnedInPlace(next, m.id);
  }
  const unused = Object.values(next.groups).filter((x) => !after.groups[x.id] && !x.tabIds.length);
  if (unused.length) {
    const groups = { ...next.groups };
    for (const x of unused) delete groups[x.id];
    next = { ...next, groups };
  }
  return keepUngroupedTabs(next, g.windowId, new Set([before.groups[groupId]!, ...mirrors].flatMap((x) => x.tabIds)));
}

function withCounterpart(s: BrowserState, group: TabGroup, windowId: string): [BrowserState, string | null] {
  const found = Object.values(s.groups).find((x) => x.windowId === windowId && x.profileId === group.profileId && !x.pinned && pinKeyOf(x) === pinKeyOf(group));
  if (found) return [s, found.id];
  if (group.pinned || !s.windows[windowId]) return [s, null];
  const outer = group.parentId ? s.groups[group.parentId] : undefined;
  const [withOuter, outerId] = outer ? withCounterpart(s, outer, windowId) : [s, null];
  const id = newId("g");
  const created: TabGroup = {
    id,
    windowId,
    profileId: group.profileId,
    pinKey: pinKeyOf(group),
    name: group.name,
    icon: group.icon,
    color: group.color,
    collapsed: group.collapsed,
    pinned: false,
    tabIds: [],
    createdAt: Date.now(),
    ...(outerId ? { parentId: outerId } : {}),
  };
  return [{ ...withOuter, groups: { ...withOuter.groups, [id]: created } }, id];
}

function withUnpinnedInPlace(s: BrowserState, groupId: string): BrowserState {
  const m = s.groups[groupId]!;
  const groups = nestGroups({ ...s.groups, [groupId]: withParent({ ...m, pinned: false }, undefined) });
  const win = s.windows[m.windowId];
  if (!win) return { ...s, groups };
  const window = { ...win, tabIds: orderSections(win.tabIds, s.tabs, groups) };
  return { ...s, groups: syncGroupOrder(groups, window), windows: { ...s.windows, [win.id]: window } };
}

const ownsPage = (t: Tab) => hasPage(t) || !!wakeOf(t);

const rankFor = (homeId: string) => (t: Tab) => (hasPage(t) ? 4 : 0) + (wakeOf(t) || adoptOf(t) ? 2 : 0) + (t.windowId === homeId ? 1 : 0);

const sharedRow = (s: BrowserState, t: Tab, paired: Set<string>) => !t.pin && !paired.has(t.id) && !inPinnedContainer(s, t.id) && isRegularWindow(s.windows[t.windowId]);

const pairedIds = (s: BrowserState) => new Set(Object.values(s.splits ?? {}).flatMap((v) => splitTabIds(v)));

function withOwnKeys(s: BrowserState, ids: Iterable<string>): BrowserState {
  let tabs: Record<string, Tab> | null = null;
  for (const id of ids) {
    const t = (tabs ?? s.tabs)[id];
    if (!t) continue;
    const was = pinKeyOf(t);
    const key = newId("tab");
    tabs ??= { ...s.tabs };
    tabs[id] = { ...t, pinKey: key };
    for (const f of Object.values(tabs)) if (f.id !== id && holderOfPage(f) === id && pinKeyOf(f) === was) tabs[f.id] = { ...f, pinKey: key };
  }
  return tabs ? { ...s, tabs } : s;
}

function keepOwnAddresses(s: BrowserState, homeId: string, members: Set<string>): BrowserState {
  const paired = pairedIds(s);
  const keys = new Set([...members].map((id) => s.tabs[id]).filter((t): t is Tab => !!t).map(pinKeyOf));
  const families = new Map<string, Tab[]>();
  for (const t of Object.values(s.tabs)) {
    if (!keys.has(pinKeyOf(t)) || !sharedRow(s, t, paired)) continue;
    const family = `${t.profileId} ${pinKeyOf(t)}`;
    families.get(family)?.push(t) ?? families.set(family, [t]);
  }
  const rank = rankFor(homeId);
  const apart: string[] = [];
  let tabs: Record<string, Tab> | null = null;
  for (const family of families.values()) {
    const primary = [...family].sort((x, y) => rank(y) - rank(x) || y.lastActiveAt - x.lastActiveAt)[0]!;
    for (const t of family) {
      if (t.id === primary.id || t.url === primary.url) continue;
      if (ownsPage(t)) apart.push(t.id);
      else if (!holderOfPage(t)) (tabs ??= { ...s.tabs })[t.id] = { ...t, url: primary.url, title: primary.title, favicon: primary.favicon };
    }
  }
  return withOwnKeys(tabs ? { ...s, tabs } : s, apart);
}

function keepSameTabRows(s: BrowserState, members: Set<string>): BrowserState {
  const holders = new Set(Object.values(s.tabs).map(holderOfPage).filter(Boolean));
  const apart = new Set<string>();
  for (const id of members) {
    const m = s.tabs[id];
    if (!m || apart.has(id) || !ownsPage(m) || inPinnedContainer(s, id)) continue;
    for (const rowId of s.windows[m.windowId]?.tabIds ?? []) {
      const t = s.tabs[rowId];
      if (!t || apart.has(rowId) || members.has(rowId) || t.pin || t.profileId !== m.profileId || pinKeyOf(t) !== pinKeyOf(m) || !ownsPage(t) || inPinnedContainer(s, rowId)) continue;
      if (holders.has(t.id) && !holders.has(m.id)) {
        apart.add(m.id);
        break;
      }
      apart.add(t.id);
    }
  }
  return withOwnKeys(s, apart);
}

function keepSplitsHome(s: BrowserState, homeId: string, members: Set<string>): BrowserState {
  if (!Object.keys(s.splits ?? {}).length) return s;
  const released = (id: string) => members.has(id) && !!s.tabs[id] && !inPinnedContainer(s, id);
  const releasing = (v: BrowserState["splits"][string]) => splitTabIds(v).some(released) && splitTabIds(v).every((id) => !!s.tabs[id]);
  const affected = Object.values(s.splits).filter(releasing);
  if (!affected.length) return s;
  const focusRank = (windowId: string) => {
    const at = s.ui?.focusOrder?.indexOf(windowId) ?? -1;
    return windowId === homeId ? -1 : at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const mirrored = (v: BrowserState["splits"][string]) => splitTabIds(v).every((id) => released(id) || (inPinnedContainer(s, id) && s.tabs[id]?.pin?.as !== "tile"));
  const sameTabs = new Map<string, BrowserState["splits"][string][]>();
  const homeSplits: BrowserState["splits"][string][] = [];
  for (const v of affected) {
    if (!mirrored(v)) {
      homeSplits.push(v);
      continue;
    }
    const key = splitTabIds(v).map((id) => pinKeyOf(s.tabs[id]!)).sort().join(" ");
    sameTabs.get(key)?.push(v) ?? sameTabs.set(key, [v]);
  }
  for (const copies of sameTabs.values()) homeSplits.push(copies.reduce((x, y) => (focusRank(y.windowId) < focusRank(x.windowId) ? y : x)));
  homeSplits.sort((x, y) => focusRank(x.windowId) - focusRank(y.windowId));
  const claimed = new Set<string>();
  const apart: string[] = [];
  for (const id of homeSplits.flatMap((v) => splitTabIds(v)).filter(released)) {
    const key = `${s.tabs[id]!.profileId} ${pinKeyOf(s.tabs[id]!)}`;
    if (claimed.has(key)) apart.push(id);
    else claimed.add(key);
  }
  const homePanes = homeSplits.flatMap((v) => splitTabIds(v)).filter((id) => released(id) && !apart.includes(id));
  const profileOf = new Map(homePanes.map((id) => [pinKeyOf(s.tabs[id]!), s.tabs[id]!.profileId]));
  const away = affected.filter((v) => !homeSplits.includes(v));
  const splits = { ...s.splits };
  for (const v of away) delete splits[v.id];
  let next: BrowserState = withOwnKeys({ ...s, splits }, apart);
  const rank = rankFor(homeId);
  for (const id of homePanes) {
    const pane = next.tabs[id]!;
    if (ownsPage(pane)) continue;
    const paired = pairedIds(next);
    const owners = Object.values(next.tabs).filter((t) => ownsPage(t) && pinKeyOf(t) === pinKeyOf(pane) && t.profileId === pane.profileId && sharedRow(next, t, paired));
    const heir = owners.find((t) => t.id === holderOfPage(pane)) ?? owners.sort((x, y) => rank(y) - rank(x) || y.lastActiveAt - x.lastActiveAt)[0];
    if (heir) next = swapPlaces(next, heir.id, id);
  }
  const paired = pairedIds(next);
  const copies = Object.values(next.tabs).filter((t) => profileOf.get(pinKeyOf(t)) === t.profileId && sharedRow(next, t, paired));
  next = withOwnKeys(next, copies.filter(ownsPage).map((t) => t.id));
  const gone = copies.filter((t) => !ownsPage(t) && pinKeyOf(next.tabs[t.id]!) === pinKeyOf(t)).map((t) => t.id);
  if (!gone.length) return next;
  for (const windowId of new Set(gone.map((id) => next.tabs[id]!.windowId))) next = keepShownProfile(next, windowId, gone);
  return removeTabs(next, gone, false);
}
