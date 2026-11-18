import type { BrowserState } from "../browser/store";
import { activeTabId, isIncognitoSpace } from "../browser/model";
import { isPeekTab } from "../peek/peek";
import { INTERNAL_PAGES, internalPageOf } from "../pages/urls";
import { pluginPageOf } from "../plugins/pageNames";
import { groupOf } from "../pins/tabGrouping";
import { focusedWindowOf } from "../windows/ui";

export type AutomationWindowKind = "normal" | "little";
export type AutomationTab = { id: string; url: string; title: string; profile: string; active: boolean; pinned: boolean; group: string | null };
export type AutomationWindow = { id: string; kind: AutomationWindowKind; focused: boolean; profile: string; profileName: string; tabs: AutomationTab[] };

type Snapshot = Pick<BrowserState, "windows" | "windowOrder" | "tabs" | "peeks" | "groups" | "spaces" | "ui">;

export const ownEntry = <T>(record: Readonly<Record<string, T>>, id: unknown): T | undefined =>
  typeof id === "string" && Object.prototype.hasOwnProperty.call(record, id) ? record[id] : undefined;

export function eligibleKind(s: Pick<BrowserState, "windows">, windowId: string | null | undefined): AutomationWindowKind | null {
  const w = ownEntry(s.windows, windowId);
  if (!w || w.kind === "private" || isIncognitoSpace(w.spaceId)) return null;
  return w.kind === "small" ? "little" : "normal";
}

export function isEligibleTab(s: Pick<BrowserState, "windows" | "tabs" | "peeks">, tabId: string): boolean {
  const t = ownEntry(s.tabs, tabId);
  return !!t && eligibleKind(s, t.windowId) !== null && !isIncognitoSpace(t.spaceId) && !isPeekTab(s, tabId);
}

export function shownPage(t: { url: string; title: string; customTitle?: string | null }): { url: string; title: string } {
  const page = internalPageOf(t.url);
  if (page) return { url: t.url.replace(/[?#].*$/, ""), title: INTERNAL_PAGES[page].title };
  if (pluginPageOf(t.url)) return { url: t.url.replace(/[?#].*$/, ""), title: t.customTitle || t.title };
  return { url: t.url, title: t.customTitle || t.title };
}

export function lastFocusedEligibleWindow(s: Pick<BrowserState, "windows" | "windowOrder" | "ui">): string | null {
  return s.ui.focusOrder.find((id) => eligibleKind(s, id)) ?? s.windowOrder.find((id) => eligibleKind(s, id)) ?? null;
}

export function windowTabIds(s: Snapshot, windowId: string): string[] {
  return (s.windows[windowId]?.tabIds ?? []).filter((id) => s.tabs[id]?.windowId === windowId && isEligibleTab(s, id));
}

export function automationWindows(s: Snapshot): AutomationWindow[] {
  const focused = focusedWindowOf(s);
  return s.windowOrder.flatMap((id) => {
    const kind = eligibleKind(s, id);
    const w = s.windows[id];
    if (!kind || !w) return [];
    const active = activeTabId(s as BrowserState, id);
    const tabs = windowTabIds(s, id).map((tabId): AutomationTab => {
      const t = s.tabs[tabId]!;
      return { id: tabId, ...shownPage(t), profile: t.spaceId, active: tabId === active, pinned: t.pin !== null, group: groupOf(s, tabId)?.id ?? null };
    });
    return [{ id, kind, focused: id === focused, profile: w.spaceId, profileName: s.spaces[w.spaceId]?.name ?? "", tabs }];
  });
}
