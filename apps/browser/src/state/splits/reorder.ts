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

export function reshapeTwoPane(
  existing: SplitView,
  anchorId: string,
  tabId: string,
  side: "left" | "right" | "top" | "bottom",
): { split: SplitView; changed: boolean } {
  const orientation = side === "left" || side === "right" ? "horizontal" : "vertical";
  const order = side === "left" || side === "top" ? [tabId, anchorId] : [anchorId, tabId];
  const ids = existing.slots.flatMap((slot) => ("stack" in slot ? slot.stack : [slot.tabId]));
  if (existing.orientation === orientation && ids[0] === order[0] && ids[1] === order[1]) return { split: existing, changed: false };
  return { split: { ...existing, orientation, slots: order.map((id) => ({ size: 0.5, tabId: id })) }, changed: true };
}
