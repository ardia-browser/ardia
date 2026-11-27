import { newId } from "../browser/model";
import type { SplitSlot, SplitView } from "../browser/types";

export const MAX_SPLIT_PANES = 3;

export type SplitSide = "left" | "right" | "top" | "bottom";
export type PaneDirection = "left" | "right" | "up" | "down";
export type PaneBox = { x: number; y: number; width: number; height: number };

type Layout = Pick<SplitView, "orientation" | "slots">;

const flatIds = new WeakMap<SplitSlot[], string[]>();

export const slotTabIds = (slot: SplitSlot): string[] => ("stack" in slot ? slot.stack : [slot.tabId]);

export function splitTabIds(split: Pick<SplitView, "slots">): string[] {
  let ids = flatIds.get(split.slots);
  if (!ids) flatIds.set(split.slots, (ids = split.slots.flatMap(slotTabIds)));
  return ids;
}

export const splitTabIdsOf = (split: Pick<SplitView, "slots"> | undefined): string[] | undefined => (split ? splitTabIds(split) : undefined);

export const isStacked = (split: Pick<SplitView, "slots">, tabId: string) => split.slots.some((slot) => "stack" in slot && slot.stack.includes(tabId));

export const evenSlots = (ids: string[]): SplitSlot[] => ids.map((tabId) => ({ size: 1 / ids.length, tabId }));

const evened = (slots: SplitSlot[]): SplitSlot[] => slots.map((slot) => ({ ...slot, size: 1 / slots.length }));

export const mapSlotIds = (slots: SplitSlot[], f: (id: string) => string): SplitSlot[] =>
  slots.map((slot) => ("stack" in slot ? { ...slot, stack: [f(slot.stack[0]), f(slot.stack[1])] } : { ...slot, tabId: f(slot.tabId) }));

export function stackAt(split: Pick<SplitView, "slots">): number {
  let at = 0;
  for (const slot of split.slots) {
    if ("stack" in slot) return at;
    at += 1;
  }
  return -1;
}

export function withPaneIds(split: SplitView, ids: string[]): SplitView {
  let i = 0;
  const slots = split.slots.map((slot): SplitSlot => ("stack" in slot ? { ...slot, stack: [ids[i++]!, ids[i++]!] } : { ...slot, tabId: ids[i++]! }));
  return { ...split, slots };
}

const sideways = (side: SplitSide) => side === "left" || side === "right";
const leading = (side: SplitSide) => side === "left" || side === "top";
const orientationFor = (side: SplitSide): SplitView["orientation"] => (sideways(side) ? "horizontal" : "vertical");
const flipped = (orientation: SplitView["orientation"]): SplitView["orientation"] => (orientation === "horizontal" ? "vertical" : "horizontal");

function spans(sizes: readonly number[]): [number, number][] {
  let at = 0;
  return sizes.map((size, i) => {
    const start = at;
    at = i === sizes.length - 1 ? 1 : at + size;
    return [start, at - start];
  });
}

export function paneBoxes(split: Layout): Record<string, PaneBox> {
  const horizontal = split.orientation === "horizontal";
  const boxes: Record<string, PaneBox> = {};
  const main = spans(split.slots.map((slot) => slot.size));
  split.slots.forEach((slot, i) => {
    const [start, size] = main[i]!;
    const box = horizontal ? { x: start, y: 0, width: size, height: 1 } : { x: 0, y: start, width: 1, height: size };
    if (!("stack" in slot)) boxes[slot.tabId] = box;
    else spans(slot.stackSizes).forEach(([s, z], j) => (boxes[slot.stack[j]!] = horizontal ? { ...box, y: s, height: z } : { ...box, x: s, width: z }));
  });
  return boxes;
}

const EPSILON = 1e-6;

const ranksBefore = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > EPSILON) return a[i]! < b[i]!;
  return false;
};

export function paneNeighbor(split: Layout, tabId: string, direction: PaneDirection): string | null {
  const boxes = paneBoxes(split);
  const from = boxes[tabId];
  if (!from) return null;
  const across = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  const start = (b: PaneBox) => (across ? b.x : b.y);
  const end = (b: PaneBox) => (across ? b.x + b.width : b.y + b.height);
  const crossStart = (b: PaneBox) => (across ? b.y : b.x);
  const crossEnd = (b: PaneBox) => (across ? b.y + b.height : b.x + b.width);
  let best: { id: string; rank: number[] } | null = null;
  for (const [id, box] of Object.entries(boxes)) {
    if (id === tabId) continue;
    const gap = forward ? start(box) - end(from) : start(from) - end(box);
    const overlap = Math.min(crossEnd(box), crossEnd(from)) - Math.max(crossStart(box), crossStart(from));
    if (gap < -EPSILON || overlap <= EPSILON) continue;
    const rank = [gap, -overlap, crossStart(box)];
    if (!best || ranksBefore(rank, best.rank)) best = { id, rank };
  }
  return best?.id ?? null;
}

export function swappedPanes(split: SplitView, a: string, b: string): SplitView | null {
  const ids = splitTabIds(split);
  if (a === b || !ids.includes(a) || !ids.includes(b)) return null;
  return withPaneIds(split, ids.map((id) => (id === a ? b : id === b ? a : id)));
}

function insertionAt(split: Layout, anchorId: string, side: SplitSide): { at: number; along: boolean } | null {
  if (splitTabIds(split).length >= MAX_SPLIT_PANES) return null;
  const at = split.slots.findIndex((slot) => slotTabIds(slot).includes(anchorId));
  if (at < 0) return null;
  const along = (split.orientation === "horizontal") === sideways(side);
  if (!along && "stack" in split.slots[at]! && split.slots.length > 1) return null;
  return { at, along };
}

export const canInsertPane = (split: Layout | undefined, anchorId: string, side: SplitSide) => !split || !!insertionAt(split, anchorId, side);

const paired = (anchorId: string, tabId: string, side: SplitSide): Layout => ({
  orientation: orientationFor(side),
  slots: evenSlots(leading(side) ? [tabId, anchorId] : [anchorId, tabId]),
});

export function insertPane(split: SplitView | undefined, anchorId: string, tabId: string, side: SplitSide, windowId: string): SplitView | null {
  if (!split) return { id: newId("split"), windowId, ...paired(anchorId, tabId, side) };
  const place = insertionAt(split, anchorId, side);
  if (!place) return null;
  const slots = [...split.slots];
  const slot = slots[place.at]!;
  if (place.along) {
    slots.splice(leading(side) ? place.at : place.at + 1, 0, { size: 0, tabId });
    return { ...split, slots: evened(slots) };
  }
  if ("stack" in slot) {
    const ids = [...slot.stack];
    ids.splice(ids.indexOf(anchorId) + (leading(side) ? 0 : 1), 0, tabId);
    return { ...split, orientation: orientationFor(side), slots: evenSlots(ids) };
  }
  slots[place.at] = { size: slot.size, stack: leading(side) ? [tabId, anchorId] : [anchorId, tabId], stackSizes: [0.5, 0.5] };
  return { ...split, slots };
}

export function normalized<T extends Layout>(split: T): T {
  const only = split.slots.length === 1 ? split.slots[0] : undefined;
  if (!only || !("stack" in only)) return split;
  return { ...split, orientation: flipped(split.orientation), slots: only.stack.map((tabId, i) => ({ size: only.stackSizes[i]!, tabId })) };
}

export function withoutPanes(split: SplitView, gone: ReadonlySet<string>): SplitView {
  const slots = split.slots.flatMap((slot): SplitSlot[] => {
    if (!("stack" in slot)) return gone.has(slot.tabId) ? [] : [slot];
    const left = slot.stack.filter((id) => !gone.has(id));
    return left.length === 2 ? [slot] : left.length === 1 ? [{ size: slot.size, tabId: left[0]! }] : [];
  });
  const total = slots.reduce((sum, slot) => sum + slot.size, 0);
  return normalized({ ...split, slots: total > 0 ? slots.map((slot) => ({ ...slot, size: slot.size / total })) : evened(slots) });
}

const shapeOf = (split: Layout) => `${split.orientation}|${split.slots.map((slot) => slotTabIds(slot).join("+")).join(",")}`;

function reordered(split: SplitView, tabId: string, anchorId: string, side: SplitSide): SplitView | null {
  if (split.slots.some((slot) => "stack" in slot) || (split.orientation === "horizontal") !== sideways(side)) return null;
  const moving = split.slots.find((slot) => slotTabIds(slot).includes(tabId))!;
  const slots = split.slots.filter((slot) => slot !== moving);
  const at = slots.findIndex((slot) => slotTabIds(slot).includes(anchorId));
  slots.splice(leading(side) ? at : at + 1, 0, moving);
  return { ...split, slots };
}

function redocked(split: SplitView, tabId: string, anchorId: string, side: SplitSide): SplitView | null {
  const rest = withoutPanes(split, new Set([tabId]));
  return splitTabIds(rest).length < 2 ? { ...rest, ...paired(anchorId, tabId, side) } : insertPane(rest, anchorId, tabId, side, split.windowId);
}

export function movePaneTo(split: SplitView, tabId: string, anchorId: string, side: SplitSide): SplitView | null {
  const ids = splitTabIds(split);
  if (tabId === anchorId || !ids.includes(tabId) || !ids.includes(anchorId)) return null;
  const base = normalized(split);
  const moved = reordered(base, tabId, anchorId, side) ?? redocked(base, tabId, anchorId, side);
  return moved && shapeOf(moved) === shapeOf(base) ? split : moved;
}
