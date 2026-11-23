import type { SplitSlot, SplitView } from "../browser/types";

const slotContains = (slot: SplitSlot, tabId: string) => ("stack" in slot ? slot.stack.includes(tabId) : slot.tabId === tabId);
const leadTabOf = (slot: SplitSlot) => ("stack" in slot ? slot.stack[0] : slot.tabId);

function axisNeighbor(split: Pick<SplitView, "orientation" | "slots">, tabId: string, delta: 1 | -1, axis: SplitView["orientation"]): string | null {
  const index = split.slots.findIndex((slot) => slotContains(slot, tabId));
  if (index < 0) return null;
  if (split.orientation === axis) {
    const target = split.slots[index + delta];
    return target ? leadTabOf(target) : null;
  }
  const slot = split.slots[index]!;
  if (!("stack" in slot)) return null;
  const next = slot.stack.indexOf(tabId) + delta;
  return next >= 0 && next < slot.stack.length ? slot.stack[next]! : null;
}

export const horizontalNeighbor = (split: Pick<SplitView, "orientation" | "slots">, tabId: string, delta: 1 | -1): string | null =>
  axisNeighbor(split, tabId, delta, "horizontal");

export const verticalNeighbor = (split: Pick<SplitView, "orientation" | "slots">, tabId: string, delta: 1 | -1): string | null =>
  axisNeighbor(split, tabId, delta, "vertical");

export function swappedPaneIds(ids: readonly string[], a: string, b: string): string[] | null {
  if (a === b) return null;
  const i = ids.indexOf(a);
  const j = ids.indexOf(b);
  if (i < 0 || j < 0) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
