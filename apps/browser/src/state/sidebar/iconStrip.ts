import type { BrowserState } from "../browser/store";
import type { GroupColor } from "../browser/types";
import { groupEntries, keptEntries, sidebarEntries } from "./entries";
import { entryKey, parseEntry } from "./entryKey";
import { folderIdOfCell } from "../pins/tileFolders";
import { splitRowPanes } from "../splits/splits";
import { shownPinnedEntries } from "./pinnedFold";

export const STRIP_LIST_DIVIDER = "divider:list";

export type StripBar = { group: string; color: GroupColor | null };

export type StripItem =
  | { kind: "tile"; key: string; tabId: string }
  | { kind: "tileFolder"; key: string; folderId: string }
  | { kind: "divider"; key: string }
  | { kind: "tab"; key: string; tabId: string; bars: StripBar[] }
  | { kind: "split"; key: string; splitId: string; tabIds: string[]; bars: StripBar[] }
  | { kind: "group"; key: string; groupId: string; color: GroupColor | null; open: boolean; bars: StripBar[] }
  | { kind: "live"; key: string; liveFolderId: string };

function entryItems(s: BrowserState, windowId: string, profileId: string, entry: string, bars: StripBar[], out: StripItem[]) {
  const { kind, id } = parseEntry(entry);
  if (kind === "tab") return void (s.tabs[id] && out.push({ kind: "tab", key: entry, tabId: id, bars }));
  if (kind === "split") {
    const tabIds = splitRowPanes(s, s.splits[id]);
    if (tabIds.length) out.push({ kind: "split", key: entry, splitId: id, tabIds, bars });
    return;
  }
  if (kind === "live") return void out.push({ kind: "live", key: entry, liveFolderId: id });
  if (kind !== "group") return;
  const g = s.groups[id];
  if (!g) return;
  const members = g.collapsed ? keptEntries(s, windowId, profileId, id) : groupEntries(s, id);
  if (g.collapsed || !members.length) out.push({ kind: "group", key: entry, groupId: id, color: g.color, open: !g.collapsed, bars });
  const inside = [...bars, { group: id, color: g.color }];
  for (const member of members) entryItems(s, windowId, profileId, member, inside, out);
}

export function iconStripItems(s: BrowserState, windowId: string, profileId: string, pinnedSequence?: string[]): StripItem[] {
  const { cells, pinned: pinnedRows, list } = sidebarEntries(s, windowId, profileId);
  const pinned = shownPinnedEntries(s, windowId, profileId, pinnedSequence ?? pinnedRows);
  const out: StripItem[] = [];
  for (const cell of cells) {
    const folderId = folderIdOfCell(cell);
    out.push(folderId ? { kind: "tileFolder", key: entryKey("tileFolder", folderId), folderId } : { kind: "tile", key: entryKey("tab", cell), tabId: cell });
  }
  const rows: StripItem[] = [];
  for (const entry of pinned) entryItems(s, windowId, profileId, entry, [], rows);
  const pinnedShown = rows.length;
  for (const entry of list) entryItems(s, windowId, profileId, entry, [], rows);
  if (out.length && rows.length) out.push({ kind: "divider", key: pinnedShown ? "divider:tiles" : STRIP_LIST_DIVIDER });
  if (pinnedShown && rows.length > pinnedShown) rows.splice(pinnedShown, 0, { kind: "divider", key: STRIP_LIST_DIVIDER });
  return out.concat(rows);
}

const SEP = "\u0001";

const barsCode = (bars: StripBar[]) => bars.map((b) => `${b.group}|${b.color ?? ""}`).join(";");

const barsOf = (code: string | undefined): StripBar[] =>
  code
    ? code.split(";").map((part) => {
        const [group = "", color = ""] = part.split("|");
        return { group, color: (color || null) as GroupColor | null };
      })
    : [];

export const stripItemCode = (item: StripItem): string => {
  switch (item.kind) {
    case "tile":
      return [item.kind, item.key, item.tabId].join(SEP);
    case "tab":
      return [item.kind, item.key, item.tabId, barsCode(item.bars)].join(SEP);
    case "tileFolder":
      return [item.kind, item.key, item.folderId].join(SEP);
    case "divider":
      return [item.kind, item.key].join(SEP);
    case "split":
      return [item.kind, item.key, item.splitId, item.tabIds.join(","), barsCode(item.bars)].join(SEP);
    case "group":
      return [item.kind, item.key, item.groupId, item.color ?? "", item.open ? 1 : 0, barsCode(item.bars)].join(SEP);
    case "live":
      return [item.kind, item.key, item.liveFolderId].join(SEP);
  }
};

export function stripItemOf(code: string): StripItem {
  const [kind, key, a = "", b = "", c = "", d = ""] = code.split(SEP) as [StripItem["kind"], string, ...string[]];
  switch (kind) {
    case "tile":
      return { kind, key, tabId: a };
    case "tab":
      return { kind, key, tabId: a, bars: barsOf(b) };
    case "tileFolder":
      return { kind, key, folderId: a };
    case "divider":
      return { kind, key };
    case "split":
      return { kind, key, splitId: a, tabIds: b ? b.split(",") : [], bars: barsOf(c) };
    case "group":
      return { kind, key, groupId: a, color: (b || null) as GroupColor | null, open: c === "1", bars: barsOf(d) };
    case "live":
      return { kind, key, liveFolderId: a };
  }
}

export const iconStripCodes = (s: BrowserState, windowId: string, profileId: string, pinnedSequence?: string[]): string[] => iconStripItems(s, windowId, profileId, pinnedSequence).map(stripItemCode);
