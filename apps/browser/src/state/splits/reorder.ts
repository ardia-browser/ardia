import type { SplitView } from "../browser/types";
import { slotTabIds, splitTabIds, withPaneIds } from "./splits";

export type SplitDirection = "left" | "right" | "up" | "down";

export function paneNeighbor(split: SplitView, tabId: string, direction: SplitDirection): string | null {
  const slotIndex = split.slots.findIndex((slot) => slotTabIds(slot).includes(tabId));
  if (slotIndex < 0) return null;
  const slot = split.slots[slotIndex]!;
  const alongMain = (split.orientation === "horizontal") === (direction === "left" || direction === "right");
  const delta = direction === "left" || direction === "up" ? -1 : 1;
  if (alongMain) {
    const target = split.slots[slotIndex + delta];
    if (!target) return null;
    return "stack" in target ? target.stack[0] : target.tabId;
  }
  if (!("stack" in slot)) return null;
  const stackIndex = slot.stack.indexOf(tabId);
  return slot.stack[stackIndex + delta] ?? null;
}

export function swappedSplit(split: SplitView, a: string, b: string): SplitView | null {
  if (a === b) return null;
  const ids = [...splitTabIds(split)];
  const i = ids.indexOf(a);
  const j = ids.indexOf(b);
  if (i < 0 || j < 0) return null;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return withPaneIds(split, ids);
}

export function reorderedSplit(split: SplitView, tabIds: string[]): SplitView | null {
  const current = splitTabIds(split);
  if (tabIds.length !== current.length) return null;
  if (current.every((id, i) => id === tabIds[i])) return null;
  const expected = new Set(current);
  const next = new Set(tabIds);
  if (next.size !== expected.size || tabIds.some((id) => !expected.has(id))) return null;
  return withPaneIds(split, tabIds);
}
