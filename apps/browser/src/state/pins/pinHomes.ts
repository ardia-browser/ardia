import type { BrowserState } from "../browser/store";
import { changedIds, linkEdits } from "../browser/changes";
import { pinnedGroupMembers } from "../browser/structure";
import type { Tab } from "../browser/types";
import { pinHomeOf } from "../browser/model";
import { sameAddress } from "../../lib/url";

type HomeSource = Pick<BrowserState, "tabs" | "groups" | "windows">;

export type ReopenChoice = { pinnedTabsReopenAtPinnedUrl?: boolean };

export const reopensAtPinnedUrl = (settings: ReopenChoice | undefined, t: Pick<Tab, "reopenAtPinnedUrl">): boolean =>
  t.reopenAtPinnedUrl ?? settings?.pinnedTabsReopenAtPinnedUrl ?? true;

export const awayFromHome = (t: Pick<Tab, "url" | "pinnedUrl">): boolean => !!t.pinnedUrl && !!t.url && !sameAddress(t.url, t.pinnedUrl);

export const keepsLastPage = (settings: ReopenChoice | undefined, t: Pick<Tab, "url" | "pinnedUrl" | "reopenAtPinnedUrl">): boolean =>
  awayFromHome(t) && !reopensAtPinnedUrl(settings, t);

export const pinHome = (t: Pick<Tab, "url" | "pinnedUrl">, housed: boolean): string | null => (housed ? pinHomeOf(t) || null : null);

export function settlePinHomes(s: HomeSource, prev: HomeSource): Pick<BrowserState, "tabs"> | null {
  if (s.tabs === prev.tabs && s.groups === prev.groups) return null;
  const members = pinnedGroupMembers(s.groups);
  const ids = s.groups !== prev.groups ? Object.keys(s.tabs) : changedIds(s.tabs, prev.tabs);
  let tabs: Record<string, Tab> | null = null;
  const homed: string[] = [];
  for (const id of ids) {
    const t = s.tabs[id];
    if (!t) continue;
    const housed = !!t.pin || members.has(id);
    if (!housed && t.liveItem) continue;
    const home = pinHome(t, housed);
    if (home === t.pinnedUrl) continue;
    tabs ??= { ...s.tabs };
    tabs[id] = { ...t, pinnedUrl: home };
    homed.push(id);
  }
  return tabs ? { tabs: linkEdits(tabs, s.tabs, homed) } : null;
}

export function pinnedTabsLeaveLive(s: Pick<BrowserState, "tabs">, prev: Pick<BrowserState, "tabs">): Pick<BrowserState, "tabs"> | null {
  if (s.tabs === prev.tabs) return null;
  let tabs: Record<string, Tab> | null = null;
  const left: string[] = [];
  for (const id of changedIds(s.tabs, prev.tabs)) {
    const t = s.tabs[id];
    if (!t?.pin || !t.liveItem || prev.tabs[id]?.pin) continue;
    tabs ??= { ...s.tabs };
    const { liveItem: _, ...rest } = t;
    tabs[id] = rest;
    left.push(id);
  }
  return tabs ? { tabs: linkEdits(tabs, s.tabs, left) } : null;
}
