import type { BrowserState } from "../browser/store";
import type { GroupColor } from "../browser/types";
import { groupEntries, sidebarEntries } from "./entries";
import { entryKey, parseEntry } from "./entryKey";
import { folderIdOfCell } from "../pins/tileFolders";
import { splitRowPanes } from "../splits/splits";
import { shownPinnedEntries } from "./pinnedFold";

export type StripBar = { color: GroupColor | null; first: boolean; last: boolean };

export type StripItem =
  | { kind: "tile"; key: string; tabId: string }
  | { kind: "tileFolder"; key: string; folderId: string }
  | { kind: "divider"; key: string }
  | { kind: "tab"; key: string; tabId: string; bar: StripBar | null }
  | { kind: "split"; key: string; splitId: string; tabIds: string[]; bar: StripBar | null }
  | { kind: "group"; key: string; groupId: string; color: GroupColor | null; open: boolean; bar: StripBar | null }
  | { kind: "live"; key: string; liveFolderId: string };

function entryItems(s: BrowserState, entry: string, bar: StripBar | null, out: StripItem[]) {
  const { kind, id } = parseEntry(entry);
  if (kind === "tab") return void (s.tabs[id] && out.push({ kind: "tab", key: entry, tabId: id, bar }));
  if (kind === "split") {
    const tabIds = splitRowPanes(s, s.splits[id]);
    if (tabIds.length) out.push({ kind: "split", key: entry, splitId: id, tabIds, bar });
    return;
  }
  if (kind === "live") return void out.push({ kind: "live", key: entry, liveFolderId: id });
  if (kind !== "group") return;
  const g = s.groups[id];
  if (!g) return;
  out.push({ kind: "group", key: entry, groupId: id, color: g.color, open: !g.collapsed, bar });
  if (g.collapsed) return;
  const members = groupEntries(s, id);
  members.forEach((member, i) => entryItems(s, member, { color: g.color, first: i === 0, last: i === members.length - 1 }, out));
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
  for (const entry of pinned) entryItems(s, entry, null, rows);
  const pinnedShown = rows.length;
  for (const entry of list) entryItems(s, entry, null, rows);
  if (out.length && rows.length) out.push({ kind: "divider", key: "divider:tiles" });
  if (pinnedShown && rows.length > pinnedShown) rows.splice(pinnedShown, 0, { kind: "divider", key: "divider:pinned" });
  return out.concat(rows);
}

const SEP = "\u0001";

export const stripItemCode = (item: StripItem): string => {
  const bar = "bar" in item && item.bar ? [item.bar.color ?? "", item.bar.first ? 1 : 0, item.bar.last ? 1 : 0].join(",") : "";
  switch (item.kind) {
    case "tile":
    case "tab":
      return [item.kind, item.key, item.tabId, bar].join(SEP);
    case "tileFolder":
      return [item.kind, item.key, item.folderId].join(SEP);
    case "divider":
      return [item.kind, item.key].join(SEP);
    case "split":
      return [item.kind, item.key, item.splitId, item.tabIds.join(","), bar].join(SEP);
    case "group":
      return [item.kind, item.key, item.groupId, item.color ?? "", item.open ? 1 : 0, bar].join(SEP);
    case "live":
      return [item.kind, item.key, item.liveFolderId].join(SEP);
  }
};

const barOf = (code: string | undefined): StripBar | null => {
  if (!code) return null;
  const [color, first, last] = code.split(",");
  return { color: (color || null) as GroupColor | null, first: first === "1", last: last === "1" };
};

export function stripItemOf(code: string): StripItem {
  const [kind, key, a = "", b = "", c = "", d = ""] = code.split(SEP) as [StripItem["kind"], string, ...string[]];
  switch (kind) {
    case "tile":
      return { kind, key, tabId: a };
    case "tab":
      return { kind, key, tabId: a, bar: barOf(b) };
    case "tileFolder":
      return { kind, key, folderId: a };
    case "divider":
      return { kind, key };
    case "split":
      return { kind, key, splitId: a, tabIds: b ? b.split(",") : [], bar: barOf(c) };
    case "group":
      return { kind, key, groupId: a, color: (b || null) as GroupColor | null, open: c === "1", bar: barOf(d) };
    case "live":
      return { kind, key, liveFolderId: a };
  }
}

export const iconStripCodes = (s: BrowserState, windowId: string, profileId: string, pinnedSequence?: string[]): string[] => iconStripItems(s, windowId, profileId, pinnedSequence).map(stripItemCode);
