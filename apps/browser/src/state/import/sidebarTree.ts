import { TAB_GROUP_COLORS, type TabGroupColor } from "@ardia/core";
import type { BookmarkNode as ImportedNode, ImportedFavicon, SpaceSuggestion } from "../../platform/importModule";
import { addGroupsFromDrafts } from "../bookmarks/bookmarkGroups";
import type { GroupDraft } from "../groups/draftGroups";
import { syncGroupOrder } from "../groups/groups";
import { useBrowser } from "../browser/store";
import { newProfileLiveFolder } from "../live/engine";
import { live } from "../live/store";
import type { LiveSourceId } from "../live/types";
import { setProfileTheme } from "../profiles/themeActions";
import { noteImportedPins } from "../telemetry/usage";
import type { ConsentToken } from "../telemetry/client";
import { isRegularWindow, mainWindowFor } from "../windows/small";
import { parseArcTheme } from "./arcTheme";
import { importFavicons, importTabs, importTabsWithSplits, linksOf, windowFor, type ImportedTabs, type IncomingTab } from "./tabImport";

const SPLIT_ROLE = "split";
const isSplitNode = (n: ImportedNode) => n.type === "folder" && n.role === SPLIT_ROLE;
const hasPageTitle = (n: ImportedNode): n is ImportedNode & { pageTitle: string } => n.pageTitle != null;

const groupColorOf = (color: string | undefined): TabGroupColor | undefined => TAB_GROUP_COLORS.find((c) => c === color);

const toGroupDraft = (n: ImportedNode): GroupDraft => {
  if (n.type === "url") return { title: hasPageTitle(n) ? n.pageTitle : n.title, url: n.url ?? "", ...(hasPageTitle(n) ? { customTitle: n.title } : {}) };
  const color = groupColorOf(n.color);
  return {
    title: n.title,
    ...(n.role === SPLIT_ROLE ? { split: true } : {}),
    ...(n.icon ? { icon: n.icon } : {}),
    ...(color ? { color } : {}),
    children: (n.children ?? []).map(toGroupDraft),
  };
};

const LIVE_SOURCES: Partial<Record<NonNullable<ImportedNode["role"]>, LiveSourceId>> = {
  liveGitHubPullRequests: "github",
  liveBitbucketPullRequests: "bitbucket",
};
const liveSourceOf = (n: ImportedNode) => (n.role ? LIVE_SOURCES[n.role] : undefined);
const liveSources = (nodes: ImportedNode[]): LiveSourceId[] =>
  nodes.flatMap((n) => [...(liveSourceOf(n) ? [liveSourceOf(n)!] : []), ...liveSources(n.children ?? [])]);
const withoutLiveFolders = (nodes: ImportedNode[]): ImportedNode[] =>
  nodes.filter((n) => !liveSourceOf(n)).map((n) => (n.children ? { ...n, children: withoutLiveFolders(n.children) } : n));

function importPullRequestsFolders(profileId: string, nodes: ImportedNode[]) {
  for (const source of new Set(liveSources(nodes))) {
    const have = Object.values(live().folders).some((f) => f.profileId === profileId && f.kind === "pullRequests" && f.sources.includes(source));
    if (!have) newProfileLiveFolder(profileId, "pullRequests", [source]);
  }
}

function sidebarWindowFor(profileId: string): string {
  const near = windowFor(profileId);
  const s = useBrowser.getState();
  if (isRegularWindow(s.windows[near])) return near;
  return mainWindowFor(s, profileId) ?? s.createWindow({ profileId });
}

type ImportedSection = { tabs: number; splits: number; skipped: number; groups: number };

const NO_SECTION: ImportedSection = { tabs: 0, splits: 0, skipped: 0, groups: 0 };
const sumSections = (a: ImportedSection, b: ImportedSection): ImportedSection => ({
  tabs: a.tabs + b.tabs,
  splits: a.splits + b.splits,
  skipped: a.skipped + b.skipped,
  groups: a.groups + b.groups,
});
const sectionOf = (placed: ImportedTabs): ImportedSection => ({ ...NO_SECTION, tabs: placed.tabs, splits: placed.splits });

function rootGroupOf(groups: Record<string, { parentId?: string }>, id: string): string {
  const seen = new Set<string>();
  let at = id;
  while (groups[at]?.parentId && !seen.has(at)) {
    seen.add(at);
    at = groups[at]!.parentId!;
  }
  return at;
}

function importFolders(profileId: string, windowId: string, folders: ImportedNode[], pinned: boolean): ImportedSection & { tabIds: string[] } {
  if (!folders.length) return { ...NO_SECTION, tabIds: [] };
  const drafts = addGroupsFromDrafts(profileId, folders.map(toGroupDraft), windowId, { collapsed: true, pinned });
  const s = useBrowser.getState();
  const made = new Set(drafts.made);
  const members = new Set(drafts.made.flatMap((id) => s.groups[id]?.tabIds ?? []));
  return {
    tabs: drafts.made.reduce((n, id) => n + (s.groups[id]?.tabIds.length ?? 0), 0),
    splits: drafts.splits,
    skipped: drafts.skipped,
    groups: Object.values(s.groups).filter((g) => made.has(g.id) || (g.parentId && made.has(rootGroupOf(s.groups, g.id)))).length,
    tabIds: (s.windows[windowId]?.tabIds ?? []).filter((id) => members.has(id)),
  };
}

const rowTab = (n: ImportedNode): IncomingTab => ({
  url: n.url!,
  title: hasPageTitle(n) ? n.pageTitle : n.title,
  pinned: true,
  row: true,
  customTitle: hasPageTitle(n) ? n.title : undefined,
});

const pinnedRowsOf = (n: ImportedNode, i: number): IncomingTab[] => {
  if (n.type === "url") return n.url ? [rowTab(n)] : [];
  if (!isSplitNode(n)) return [];
  return (n.children ?? []).filter((c) => c.type === "url" && c.url).map((c) => ({ ...rowTab(c), splitId: `pinned-${i}` }));
};

type PinnedPart = ImportedSection & { rows: number; blocks: Map<number, string[]> };

function importPinnedRows(profileId: string, windowId: string, pinned: ImportedNode[]): PinnedPart {
  importPullRequestsFolders(profileId, pinned);
  const part: PinnedPart = { ...NO_SECTION, rows: 0, blocks: new Map() };
  pinned.forEach((n, i) => {
    const rows = pinnedRowsOf(n, i);
    if (!rows.length) return;
    const placed = importTabsWithSplits(profileId, rows, null, "anyPin", windowId);
    Object.assign(part, sumSections(part, sectionOf(placed)));
    part.rows += placed.tabs;
    part.blocks.set(i, placed.ids);
  });
  return part;
}

function importPinnedFolders(profileId: string, windowId: string, pinned: ImportedNode[], rows: PinnedPart): PinnedPart {
  const part: PinnedPart = { ...rows, blocks: new Map(rows.blocks) };
  pinned.forEach((n, i) => {
    if (n.type !== "folder" || isSplitNode(n)) return;
    const folder = importFolders(profileId, windowId, withoutLiveFolders([n]), true);
    Object.assign(part, sumSections(part, folder));
    part.blocks.set(i, folder.tabIds);
  });
  placeInSourceOrder(windowId, part.blocks);
  return part;
}

function placeInSourceOrder(windowId: string, blocks: Map<number, string[]>) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return;
  const present = new Set(w.tabIds);
  const wanted = [...blocks.keys()].sort((a, b) => a - b).flatMap((i) => blocks.get(i)!.filter((id) => present.has(id)));
  const mine = new Set(wanted);
  const slots = w.tabIds.flatMap((id, i) => (mine.has(id) ? [i] : []));
  if (slots.length !== wanted.length) return;
  const tabIds = [...w.tabIds];
  slots.forEach((slot, k) => (tabIds[slot] = wanted[k]!));
  if (tabIds.every((id, i) => id === w.tabIds[i])) return;
  const window = { ...w, tabIds };
  useBrowser.setState({ windows: { ...s.windows, [windowId]: window }, groups: syncGroupOrder(s.groups, window) });
}

export function importArcSpace(profileId: string, space: SpaceSuggestion, favicons?: ImportedFavicon[], consent?: ConsentToken | null): { tabs: number; bookmarks: number; skipped: number } {
  importFavicons(profileId, favicons, [...linksOf(space.pinned), ...space.tabs.map((t) => t.url)]);
  const windowId = sidebarWindowFor(profileId);
  const rows = importPinnedRows(profileId, windowId, space.pinned);
  const today = importTabsWithSplits(profileId, space.tabs.map((t) => ({ ...t, pinned: false })), "Imported", "anyPin", windowId);
  const pinned = importPinnedFolders(profileId, windowId, space.pinned, rows);
  const theme = space.theme ? parseArcTheme(space.theme) : null;
  if (theme) setProfileTheme(profileId, theme);
  noteImportedPins({ rows: pinned.rows, splits: pinned.splits + today.splits }, consent);
  return { tabs: pinned.tabs + today.tabs, bookmarks: 0, skipped: pinned.skipped };
}

export type ImportedDiaSpace = { tabs: number; skipped: number; groups: number; splits: number };

export function importDiaSpace(profileId: string, space: SpaceSuggestion, favicons?: ImportedFavicon[], consent?: ConsentToken | null): ImportedDiaSpace {
  const favorites = space.favorites ?? [];
  const openGroups = space.openGroups ?? [];
  importFavicons(profileId, favicons, [...favorites.map((t) => t.url), ...linksOf(space.pinned), ...space.tabs.map((t) => t.url), ...linksOf(openGroups)]);
  const windowId = sidebarWindowFor(profileId);
  const tiles = favorites.length ? importTabs(profileId, favorites.map((t) => ({ ...t, pinned: true })), null, "tiles", windowId) : 0;
  const pinned = importPinnedFolders(profileId, windowId, space.pinned, importPinnedRows(profileId, windowId, space.pinned));
  const groups = importFolders(profileId, windowId, openGroups.filter((n) => n.type === "folder" && !isSplitNode(n)), false);
  const loose = importTabsWithSplits(profileId, space.tabs.map((t) => ({ ...t, pinned: false })), "Imported", "anyPin", windowId);
  const open = sumSections(groups, sectionOf(loose));
  noteImportedPins({ rows: pinned.rows, splits: pinned.splits + open.splits }, consent);
  return { tabs: tiles + pinned.tabs + open.tabs, skipped: pinned.skipped + open.skipped, groups: pinned.groups + open.groups, splits: pinned.splits + open.splits };
}
