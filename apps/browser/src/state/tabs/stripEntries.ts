import type { BrowserState } from "../browser/store";
import { viewTabIds } from "../browser/model";
import { groupIndex, splitIndex, stableList } from "../browser/structure";
import { hiddenEmptyCard } from "../omnibox/newTabBarPolicy";
import { folderCell, folderMembers, tileFolderOf } from "../pins/tileFolders";
import { entriesInputs, sameEntriesInputs, type EntriesInputs } from "../sidebar/entries";
import { entryKey } from "../sidebar/entryKey";
import { splitTabIds } from "../splits/splits";

export type StripMember = { kind: "tab"; id: string; group: string | null } | { kind: "split" | "folder"; id: string; tabIds: string[]; group: string | null };
export type StripGroupEntry = { kind: "group"; id: string; collapsed: boolean; members: StripMember[]; memberTabIds?: string[] };
export type StripDock = { kind: "dock"; ids: string[]; members: Map<string, string[]> };
export type StripEntry = StripDock | StripGroupEntry | StripMember;

const stripMemo = new Map<string, { inputs: EntriesInputs; keys: string[]; entries: StripEntry[] }>();

function parseStrip(keys: string[], previousDock: StripDock | undefined): StripEntry[] {
  const out: StripEntry[] = [];
  const groups = new Map<string, StripGroupEntry>();
  const dockKeys: string[] = [];
  for (const key of keys) {
    const [kind, id, a, b] = key.split(":");
    if (kind === "pinned" || kind === "tilefolder") {
      dockKeys.push(key);
      const cell = kind === "tilefolder" ? folderCell(id!) : id!;
      const last = out[out.length - 1];
      const dock = last?.kind === "dock" ? last : { kind: "dock" as const, ids: [], members: new Map<string, string[]>() };
      if (dock !== last) out.push(dock);
      dock.ids.push(cell);
      if (kind === "tilefolder") dock.members.set(cell, a!.split(","));
      continue;
    }
    if (kind === "group") {
      const group: StripGroupEntry = { kind, id: id!, collapsed: a === "1", members: [] };
      groups.set(group.id, group);
      out.push(group);
      continue;
    }
    const member: StripMember = kind === "split" || kind === "folder" ? { kind, id: id!, tabIds: a!.split(","), group: b || null } : { kind: "tab", id: id!, group: a || null };
    const group = member.group ? groups.get(member.group) : undefined;
    if (group) group.members.push(member);
    else out.push(member);
  }
  const dockAt = out.findIndex((e) => e.kind === "dock");
  if (dockAt >= 0 && previousDock && dockSignature.get(previousDock) === dockKeys.join()) out[dockAt] = previousDock;
  else if (dockAt >= 0) dockSignature.set(out[dockAt] as StripDock, dockKeys.join());
  return out;
}

const dockSignature = new WeakMap<StripDock, string>();

function foldersUnderRoots(groups: BrowserState["groups"]): Map<string, string> {
  const folderOf = new Map<string, string>();
  for (const g of Object.values(groups)) {
    if (!g.parentId || groups[g.parentId]?.parentId) continue;
    for (const id of g.tabIds) folderOf.set(id, g.id);
  }
  return folderOf;
}

export function stripEntries(s: BrowserState, windowId: string, profileId: string): StripEntry[] {
  const key = `${windowId}|${profileId}`;
  const cached = stripMemo.get(key);
  if (cached && sameEntriesInputs(s, cached.inputs)) return cached.entries;
  const inputs = entriesInputs(s);
  const groups = groupIndex(s.groups);
  const folders = foldersUnderRoots(s.groups);
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  const dock: string[] = [];
  const out: string[] = [];
  const activeId = s.windows[windowId]?.activeTabIds[profileId];
  for (const id of viewTabIds(s, windowId, profileId)) {
    const t = s.tabs[id]!;
    if (hiddenEmptyCard(s, t)) continue;
    const tileFolder = tileFolderOf(t);
    if (tileFolder) {
      const folderKey = entryKey("tileFolder", tileFolder.id);
      if (!seen.has(folderKey)) dock.push(`tilefolder:${tileFolder.id}:${folderMembers(s, windowId, tileFolder.id, profileId).join(",")}`);
      seen.add(folderKey);
      if (id === activeId) dock.push(`pinned:${id}`);
      continue;
    }
    if (t.pin) {
      dock.push(`pinned:${id}`);
      continue;
    }
    const group = groups.get(id);
    if (group && !seen.has(group.id)) {
      seen.add(group.id);
      out.push(`group:${group.id}:${group.collapsed ? 1 : 0}`);
    }
    const folder = group && folders.get(id);
    if (folder) {
      if (!seen.has(folder)) out.push(`folder:${folder}:${s.groups[folder]!.tabIds.join(",")}:${group.id}`);
      seen.add(folder);
      continue;
    }
    const split = splits.get(id)?.[0];
    if (split) {
      if (!seen.has(split.id)) out.push(`split:${split.id}:${splitTabIds(split).join(",")}:${group?.id ?? ""}`);
      seen.add(split.id);
      continue;
    }
    out.push(`tab:${id}:${group?.id ?? ""}`);
  }
  const keys = stableList(cached?.keys, [...dock, ...out]);
  const entries = cached && keys === cached.keys ? cached.entries : parseStrip(keys, cached?.entries.find((e): e is StripDock => e.kind === "dock"));
  stripMemo.set(key, { inputs, keys, entries });
  if (stripMemo.size > 8) for (const k of stripMemo.keys()) if (!s.windows[k.split("|")[0]!]) stripMemo.delete(k);
  return entries;
}
