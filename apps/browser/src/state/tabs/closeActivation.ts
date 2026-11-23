import type { BrowserState } from "../browser/store";
import { activeTabId, inPinnedContainer, isPinnedRow, tabLayoutOf } from "../browser/model";
import { useBrowser } from "../browser/store";
import { parseEntry } from "../sidebar/entryKey";
import { groupEntries, keptEntries, sidebarEntries } from "../sidebar/entries";
import { pinnedSequence } from "../sidebar/pinnedOrder";
import { pinnedCollapsed, pinnedKept } from "../sidebar/pinnedFold";
import { liveFolderTabRows } from "../sidebar/liveRows";
import { live } from "../live/store";
import { splitOf, splitRowPanes, splitTabIdsOf, withPinnedPanes } from "../splits/splits";
import { folderIdOfCell, shownFolderTab } from "../pins/tileFolders";
import { noteCloseActivation } from "../telemetry/closeActivationCounts";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { hasPage } from "./pageSession";
import { stripEntries, type StripMember } from "./stripEntries";
import { withSharedFamily } from "../pins/pinShare";
import { keptWithTopApp, successorKey, type CloseOptions, type Successor } from "./tabs";

type VisibleSection = "topApps" | "pinned" | "regular";
type VisibleRow = { ids: string[]; section: VisibleSection };
type Side = Successor["side"];

const sideOf = (s: Pick<BrowserState, "settings">): Side | null => ({ tabAbove: "above", tabBelow: "below", previouslyActive: null } as const)[s.settings.afterClosingTab];

function entryRows(s: BrowserState, windowId: string, profileId: string, entry: string): string[][] {
  const { kind, id } = parseEntry(entry);
  if (kind === "tab") return s.tabs[id] ? [[id]] : [];
  if (kind === "live") return liveFolderTabRows(s, live(), windowId, profileId, id);
  if (kind === "split") {
    const panes = splitRowPanes(s, s.splits[id]);
    return [panes.length ? panes : (splitTabIdsOf(s.splits[id]) ?? [])];
  }
  if (kind !== "group" || !s.groups[id]) return [];
  const shown = s.groups[id]!.collapsed ? keptEntries(s, windowId, profileId, id) : groupEntries(s, id);
  return shown.flatMap((e) => entryRows(s, windowId, profileId, e));
}

function sidebarRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  const { cells, list } = sidebarEntries(s, windowId, profileId);
  const tile = (cell: string): string[] => {
    const folderId = folderIdOfCell(cell);
    if (!folderId) return s.tabs[cell] ? [cell] : [];
    return [shownFolderTab(s, windowId, profileId, folderId) ?? []].flat();
  };
  const sequence = pinnedSequence(s, live().folders, live().folderOrder, windowId, profileId);
  const shownPinned = pinnedCollapsed(s, profileId) ? [pinnedKept(s, windowId, profileId, sequence) ?? []].flat() : sequence;
  const rows = (entries: string[], section: VisibleSection) => entries.flatMap((e) => entryRows(s, windowId, profileId, e)).map((ids) => ({ ids, section }));
  return [...cells.map(tile).filter((ids) => ids.length).map((ids) => ({ ids, section: "topApps" as const })), ...rows(shownPinned, "pinned"), ...rows(list, "regular")];
}

const memberHolds = (m: StripMember, tabId: string) => (m.kind === "tab" ? m.id === tabId : m.tabIds.includes(tabId));

function memberRows(m: StripMember, activeId: string): string[][] {
  if (m.kind === "tab") return [[m.id]];
  if (m.kind === "split") return [m.tabIds];
  return m.tabIds.includes(activeId) ? [[activeId]] : [];
}

function stripRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  const activeId = activeTabId(s, windowId, profileId) ?? "";
  const rows: VisibleRow[] = [];
  for (const e of stripEntries(s, windowId, profileId)) {
    if (e.kind === "dock") {
      for (const id of e.ids) if (s.tabs[id]) rows.push({ ids: [id], section: isPinnedRow(s.tabs[id]) ? "pinned" : "topApps" });
      continue;
    }
    const section: VisibleSection = e.kind === "group" && s.groups[e.id]?.pinned ? "pinned" : "regular";
    const members = e.kind === "group" ? e.members.filter((m) => !e.collapsed || memberHolds(m, activeId)) : [e];
    for (const m of members) for (const ids of memberRows(m, activeId)) rows.push({ ids, section });
  }
  return rows;
}

export function visibleRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  return tabLayoutOf(s, windowId) === "top" ? stripRows(s, windowId, profileId) : sidebarRows(s, windowId, profileId);
}

const latest = (s: BrowserState, ids: string[]) => ids.reduce<string | undefined>((best, id) => (!best || s.tabs[id]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? id : best), undefined);

export function tabBeside(s: BrowserState, rows: VisibleRow[], closedId: string, closing: ReadonlySet<string>, eligible: (id: string) => boolean, side: Side): string | undefined {
  const section = rows.find((row) => row.ids.includes(closedId))?.section;
  if (!section) return undefined;
  const same = rows.filter((row) => row.section === section).map((row) => row.ids);
  const ordered = side === "above" ? same : [...same].reverse();
  const edge = ordered.findIndex((ids) => ids.some((id) => closing.has(id)));
  const survivor = (ids: string[]) => latest(s, ids.filter((id) => !closing.has(id) && eligible(id)));
  for (let i = edge - 1; i >= 0; i--) {
    const id = survivor(ordered[i]!);
    if (id) return id;
  }
  for (let i = Math.max(edge, 0); i < ordered.length; i++) {
    const id = survivor(ordered[i]!);
    if (id) return id;
  }
  return undefined;
}

function successorFor(s: BrowserState, windowId: string, profileId: string, activeId: string, closing: ReadonlySet<string>, requested: string[], keepTopApps: boolean, side: Side): Omit<Successor, "shown"> | null {
  const panes = splitTabIdsOf(splitOf(s, activeId)) ?? [];
  const insideSplit = requested.every((id) => panes.includes(id)) && panes.some((id) => !closing.has(id) && s.tabs[id]);
  const topApp = inPinnedContainer(s, activeId) && withPinnedPanes(s, [activeId]).some((id) => s.tabs[id]?.pin?.as === "tile");
  if (insideSplit || (topApp && keepTopApps)) return null;
  const candidate = (id: string) => {
    const t = s.tabs[id];
    return !!t && !closing.has(id) && t.windowId === windowId && t.profileId === profileId && (!inPinnedContainer(s, id) || hasPage(t)) && !(keepTopApps && keptWithTopApp(s, id));
  };
  const rows = visibleRows(s, windowId, profileId);
  const beside = tabBeside(s, rows, activeId, closing, candidate, side);
  if (beside) return { id: beside, side, beside: true };
  const fallback = topApp ? (id: string) => candidate(id) && !inPinnedContainer(s, id) : candidate;
  return { id: latest(s, rows.flatMap((row) => row.ids).filter(fallback)) ?? null, side, beside: false };
}

function pickSuccessors(s: BrowserState, ids: string[], keepTopApps = s.settings.keepTopAppsRunning): Map<string, Successor> {
  const out = new Map<string, Successor>();
  const side = sideOf(s);
  if (!side) return out;
  const requested = ids.filter((id) => s.tabs[id]);
  const pinned = requested.filter((id) => inPinnedContainer(s, id));
  const leaving = keepTopApps ? withPinnedPanes(s, pinned.filter((id) => withPinnedPanes(s, [id]).some((pane) => s.tabs[pane]?.pin?.as === "tile"))) : [];
  const closing = new Set([...requested, ...leaving, ...withSharedFamily(s, withPinnedPanes(s, pinned.filter((id) => !leaving.includes(id))))]);
  for (const w of Object.values(s.windows)) {
    for (const [profileId, activeId] of Object.entries(w.activeTabIds)) {
      if (!closing.has(activeId)) continue;
      const pick = successorFor(s, w.id, profileId, activeId, closing, requested, keepTopApps, side);
      if (pick) out.set(successorKey(w.id, profileId), { ...pick, shown: profileId === w.profileId });
    }
  }
  return out;
}

export type ByUser = { consent: ConsentToken | null };

export function userClose(ids: string[], { consent }: ByUser, options: CloseOptions = {}): CloseOptions {
  const successors = pickSuccessors(useBrowser.getState(), ids, options.keepTopApps);
  const noted = (pick: Successor) => void (pick.shown && noteCloseActivation(consent, pick.side, pick.beside));
  const shows = (s: BrowserState, windowId: string, profileId: string, id: string) => visibleRows(s, windowId, profileId).some((row) => row.ids.includes(id));
  const fallback = (s: BrowserState, windowId: string, profileId: string, activeId: string, removing: ReadonlySet<string>, side: Side) =>
    successorFor(s, windowId, profileId, activeId, removing, [...removing], options.keepTopApps ?? s.settings.keepTopAppsRunning, side)?.id ?? undefined;
  return { ...options, userClose: { successors, noted, shows, fallback } };
}
