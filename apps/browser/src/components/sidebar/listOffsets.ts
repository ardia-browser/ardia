import type { BrowserState } from "../../state/browser/store";
import { entryId } from "../../state/sidebar/entryKey";
import { layout } from "../ui/theme";

export type Offsets = { at: Map<string, number>; end: number };
export type Height = (s: BrowserState, entry: string) => number;

export function offsets(s: BrowserState, entries: string[], height: Height, start = 0, base = 0): Offsets {
  const at = new Map<string, number>();
  let y = base;
  for (let i = start; i < entries.length; i++) {
    at.set(entries[i]!, y);
    y += height(s, entries[i]!) + layout.rowGap;
  }
  return { at, end: y };
}

export function heldIn(before: BrowserState, after: BrowserState, height: Height): Height {
  return (s, entry) => {
    const groupId = entryId(entry, "group");
    const was = groupId === null ? undefined : before.groups[groupId];
    return was && was.tabIds === after.groups[groupId!]?.tabIds ? height(before, entry) : height(s, entry);
  };
}

export function sharedPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export function prefixHeight(s: BrowserState, entries: string[], count: number, height: Height): number {
  let y = 0;
  for (let i = 0; i < count; i++) y += height(s, entries[i]!) + layout.rowGap;
  return y;
}
