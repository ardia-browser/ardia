import type { Bookmarks } from "../browser/types";
import { isWithin } from "./bookmarks";

export type TreeDropRow = { id: string; expanded: boolean };

export type TreeDrop = { into: string } | { parentId: string; index: number; edge: "before" | "after" };

const INTO_BAND = { start: 0.25, end: 0.75 } as const;

export function canDragInTree(b: Bookmarks, id: string): boolean {
  const node = b.nodes[id];
  return node?.kind === "folder" && !!node.parentId;
}

const movable = (b: Bookmarks, moving: readonly string[]) => moving.length > 0 && moving.every((id) => !!b.nodes[id]?.parentId);

export function canDropInto(b: Bookmarks, moving: readonly string[], folderId: string): boolean {
  if (b.nodes[folderId]?.kind !== "folder" || !movable(b, moving)) return false;
  if (isWithin(b, folderId, moving)) return false;
  return moving.some((id) => b.nodes[id]?.parentId !== folderId);
}

function showsSubfolders(b: Bookmarks, row: TreeDropRow): boolean {
  const node = b.nodes[row.id];
  return row.expanded && node?.kind === "folder" && node.children.some((c) => b.nodes[c]?.kind === "folder");
}

function insertAt(b: Bookmarks, moving: readonly string[], parentId: string, index: number): number | null {
  const parent = b.nodes[parentId];
  if (parent?.kind !== "folder") return null;
  const leaving = new Set(moving);
  const staying = parent.children.filter((c) => !leaving.has(c));
  const at = Math.max(0, Math.min(index, staying.length));
  const next = [...staying.slice(0, at), ...moving, ...staying.slice(at)];
  const unchanged = next.length === parent.children.length && next.every((id, i) => parent.children[i] === id);
  return unchanged ? null : at;
}

export function treeDrop(b: Bookmarks, moving: readonly string[], row: TreeDropRow, fraction: number): TreeDrop | null {
  const node = b.nodes[row.id];
  if (node?.kind !== "folder" || !movable(b, moving)) return null;
  const middle = fraction > INTO_BAND.start && fraction < INTO_BAND.end;
  if (middle || !node.parentId) return canDropInto(b, moving, row.id) ? { into: row.id } : null;
  if (isWithin(b, row.id, moving)) return null;
  const edge = fraction <= INTO_BAND.start ? "before" : "after";
  if (edge === "after" && showsSubfolders(b, row)) {
    const index = insertAt(b, moving, row.id, 0);
    return index === null ? null : { parentId: row.id, index, edge };
  }
  const parent = b.nodes[node.parentId];
  if (parent?.kind !== "folder") return null;
  const leaving = new Set(moving);
  const at = parent.children.filter((c) => !leaving.has(c)).indexOf(row.id);
  const index = insertAt(b, moving, parent.id, edge === "before" ? at : at + 1);
  return index === null ? null : { parentId: parent.id, index, edge };
}
