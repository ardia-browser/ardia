import type { InstalledExtension } from "../../platform/extensions";

export type ToolbarDrag = { id: string; from: number; dx: number };

const UNORDERED = Number.MAX_SAFE_INTEGER;

export const toolbarOrder = (list: InstalledExtension[]): InstalledExtension[] =>
  list.filter((x) => x.pinned).sort((a, b) => (a.pinnedIndex ?? UNORDERED) - (b.pinnedIndex ?? UNORDERED));

export function movedToolbarOrder(shown: InstalledExtension[], id: string, to: number): { slots: Map<string, number>; pinnedIndex: number } | null {
  const order = shown.map((x) => x.id);
  const from = order.indexOf(id);
  const target = shown[to];
  if (from < 0 || !target || from === to || target.pinnedIndex === undefined) return null;
  order.splice(from, 1);
  order.splice(to, 0, id);
  const slots = shown.map((x) => x.pinnedIndex ?? UNORDERED).sort((a, b) => a - b);
  return { slots: new Map(order.map((x, i) => [x, slots[i]!])), pinnedIndex: target.pinnedIndex };
}

export const dropIndex = (from: number, dx: number, pitch: number, count: number) => Math.max(0, Math.min(count - 1, from + Math.round(dx / pitch)));

export function makeRoomShift(index: number, drag: ToolbarDrag | null, pitch: number, count: number): number {
  if (!drag || index === drag.from) return 0;
  const to = dropIndex(drag.from, drag.dx, pitch, count);
  if (drag.from < index && index <= to) return -pitch;
  if (to <= index && index < drag.from) return pitch;
  return 0;
}
