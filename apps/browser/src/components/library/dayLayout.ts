import type { DayGroup } from "../../state/library/items";

export type Slot<T> = { key: string; pool: string; top: number; height: number; item: T };

export type SlotRows<T> = { count: number; height: number; at: (index: number) => Slot<T> };

export type DaySlot<T> = { kind: "header"; title: string } | { kind: "row"; items: T[] };

export type ItemKeys = { length: number; at: (index: number) => string | undefined; indexOf: (key: string) => number };

export type DayLayout<T> = SlotRows<DaySlot<T>> & {
  keys: ItemKeys;
  itemAt: (index: number) => T | undefined;
  itemOf: (key: string, hint?: number) => T | undefined;
  slotOfItem: (index: number) => number;
  itemOfSlot: (slot: number) => number;
};

export type DayLayoutMetrics = { columns: number; header: number; untitledGap: number | null; row: number; rowGap: number; endPad: number };

type Block<T> = { group: DayGroup<T>; slot: number; item: number; top: number; header: number; rowsTop: number; rows: number };

function lastAtOrBefore<T>(blocks: Block<T>[], value: number, of: (block: Block<T>) => number) {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (of(blocks[mid]!) <= value) lo = mid;
    else hi = mid - 1;
  }
  return blocks[lo];
}

const slotStart = <T,>(block: Block<T>) => block.slot;
const itemStart = <T,>(block: Block<T>) => block.item;

export function dayLayout<T>(groups: readonly DayGroup<T>[], keyOf: (item: T) => string, m: DayLayoutMetrics): DayLayout<T> {
  const blocks: Block<T>[] = [];
  let slot = 0;
  let item = 0;
  let top = 0;
  const stride = m.row + m.rowGap;
  for (const group of groups) {
    if (!group.items.length) continue;
    const header = group.title || m.untitledGap === null ? 1 : 0;
    const rowsTop = top + (header ? m.header : (m.untitledGap ?? 0));
    const rows = Math.ceil(group.items.length / m.columns);
    blocks.push({ group, slot, item, top, header, rowsTop, rows });
    slot += header + rows;
    item += group.items.length;
    top = rowsTop + rows * stride;
  }
  const count = slot;
  const items = item;

  const at = (index: number): Slot<DaySlot<T>> => {
    const block = lastAtOrBefore(blocks, index, slotStart)!;
    const local = index - block.slot;
    if (block.header && local === 0) return { key: `h${block.group.key}`, pool: "h", top: block.top, height: m.header, item: { kind: "header", title: block.group.title } };
    const row = local - block.header;
    const first = row * m.columns;
    const rowItems = block.group.items.slice(first, first + m.columns);
    return { key: rowItems.map(keyOf).join("|"), pool: "r", top: block.rowsTop + row * stride, height: m.row, item: { kind: "row", items: rowItems } };
  };

  const itemAt = (index: number): T | undefined => {
    if (index < 0 || index >= items || !blocks.length) return undefined;
    const block = lastAtOrBefore(blocks, index, itemStart)!;
    return block.group.items[index - block.item];
  };

  let byKey: Map<string, number> | null = null;
  const indexOf = (key: string) => {
    if (!byKey) {
      byKey = new Map();
      let index = 0;
      for (const block of blocks) for (const entry of block.group.items) byKey.set(keyOf(entry), index++);
    }
    return byKey.get(key) ?? -1;
  };

  const slotOfItem = (index: number) => {
    const block = lastAtOrBefore(blocks, index, itemStart)!;
    return block.slot + block.header + Math.floor((index - block.item) / m.columns);
  };

  const itemOfSlot = (index: number) => {
    if (!blocks.length || index < 0) return -1;
    const block = lastAtOrBefore(blocks, index, slotStart)!;
    const row = Math.max(0, index - block.slot - block.header);
    return Math.min(block.item + row * m.columns, items - 1);
  };

  const keyAt = (index: number) => {
    const entry = itemAt(index);
    return entry === undefined ? undefined : keyOf(entry);
  };

  return {
    count,
    height: top + m.endPad,
    at,
    keys: { length: items, at: keyAt, indexOf },
    itemAt,
    itemOf: (key, hint = -1) => {
      const hinted = itemAt(hint);
      return hinted !== undefined && keyOf(hinted) === key ? hinted : itemAt(indexOf(key));
    },
    slotOfItem,
    itemOfSlot,
  };
}

export function sameDaySlot<T>(a: DaySlot<T>, b: DaySlot<T>): boolean {
  if (a === b) return true;
  if (a.kind === "header") return b.kind === "header" && a.title === b.title;
  if (b.kind === "header") return false;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i++) if (a.items[i] !== b.items[i]) return false;
  return true;
}

export function firstSlotEndingAfter<T>(rows: SlotRows<T>, y: number) {
  let lo = 0;
  let hi = rows.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const slot = rows.at(mid);
    if (slot.top + slot.height > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function firstSlotStartingAfter<T>(rows: SlotRows<T>, y: number) {
  let lo = 0;
  let hi = rows.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows.at(mid).top >= y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
