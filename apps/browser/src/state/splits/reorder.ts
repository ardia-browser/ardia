import type { SplitSlot, SplitView } from "../browser/types";

export type SplitDirection = "left" | "right" | "up" | "down";

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

export const paneNeighbor = (split: Pick<SplitView, "orientation" | "slots">, tabId: string, direction: SplitDirection): string | null =>
  direction === "left"
    ? horizontalNeighbor(split, tabId, -1)
    : direction === "right"
      ? horizontalNeighbor(split, tabId, 1)
      : direction === "up"
        ? verticalNeighbor(split, tabId, -1)
        : verticalNeighbor(split, tabId, 1);

export function swappedPaneIds(ids: readonly string[], a: string, b: string): string[] | null {
  if (a === b) return null;
  const i = ids.indexOf(a);
  const j = ids.indexOf(b);
  if (i < 0 || j < 0) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function swappedSplit(split: SplitView, a: string, b: string): SplitView | null {
  if (a === b) return null;
  let seenA = false;
  let seenB = false;
  const swapId = (id: string) => {
    if (id === a) {
      seenA = true;
      return b;
    }
    if (id === b) {
      seenB = true;
      return a;
    }
    return id;
  };
  const slots: SplitSlot[] = split.slots.map((slot) =>
    "stack" in slot ? { ...slot, stack: [swapId(slot.stack[0]), swapId(slot.stack[1])] } : { ...slot, tabId: swapId(slot.tabId) },
  );
  return seenA && seenB ? { ...split, slots } : null;
}

export function reorderedSplit(split: SplitView, ids: readonly string[]): SplitView | null {
  const total = split.slots.reduce((n, slot) => n + ("stack" in slot ? 2 : 1), 0);
  if (ids.length !== total) return null;
  let cursor = 0;
  const slots: SplitSlot[] = split.slots.map((slot) =>
    "stack" in slot ? { ...slot, stack: [ids[cursor++]!, ids[cursor++]!] } : { ...slot, tabId: ids[cursor++]! },
  );
  return { ...split, slots };
}
