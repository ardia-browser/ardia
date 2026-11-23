export const FOLD_ROWS_PER_FRAME = 4;

export type FoldMount = { collapsed: boolean; shown: number };

type FoldRow = { key: string; ghost?: boolean };

type FoldSlotPlan = { kind: "row"; index: number; inReach: boolean } | { kind: "spacer"; key: string; height: number };

export const foldReach = (windowHeight: number, padTop: number) => Math.max(0, windowHeight - padTop);

export function rowsWithin(entries: readonly FoldRow[], heightOf: (key: string) => number, gap: number, reach: number): number {
  let top = 0;
  let n = 0;
  while (n < entries.length && top < reach) {
    const entry = entries[n++]!;
    if (!entry.ghost) top += heightOf(entry.key) + gap;
  }
  return n;
}

export function nextFoldMount(mount: FoldMount, collapsed: boolean, entries: readonly FoldRow[], heightOf: (key: string) => number, gap: number, reach: number, step = false): FoldMount {
  const had = Math.min(mount.shown, entries.length);
  if (mount.collapsed !== collapsed) return { collapsed, shown: collapsed ? had : had >= entries.length ? Infinity : Math.max(had, rowsWithin(entries, heightOf, gap, reach)) };
  if (!step || collapsed) return mount;
  return { collapsed, shown: mount.shown >= entries.length ? Infinity : Math.min(entries.length, mount.shown + FOLD_ROWS_PER_FRAME) };
}

export function foldRows(
  entries: readonly FoldRow[],
  { shown, kept, spacers, ghosts, heightOf, gap, reach }: { shown: number; kept: ReadonlySet<string>; spacers: boolean; ghosts: boolean; heightOf: (key: string) => number; gap: number; reach: number },
): FoldSlotPlan[] {
  const out: FoldSlotPlan[] = [];
  let top = 0;
  let rest = { from: "", height: 0, count: 0 };
  const flush = () => {
    if (!rest.count) return;
    out.push({ kind: "spacer", key: `~rest:${rest.from}`, height: rest.height + gap * (rest.count - 1) });
    rest = { from: "", height: 0, count: 0 };
  };
  entries.forEach((entry, index) => {
    if (entry.ghost) {
      if (ghosts) {
        flush();
        out.push({ kind: "row", index, inReach: top < reach });
      }
      return;
    }
    const height = heightOf(entry.key);
    if (index < shown || kept.has(entry.key)) {
      flush();
      out.push({ kind: "row", index, inReach: top < reach });
    } else if (spacers) {
      if (!rest.count) rest.from = entry.key;
      rest.height += height;
      rest.count++;
    }
    top += height + gap;
  });
  flush();
  return out;
}
