import { RADII, ROW_METRICS, type ChromePart, type ThemeLook } from "./themeLook";

export const MINIMALISM_METRICS = { rowHeight: 28, rowGap: 2, pinnedHeight: 34 } as const;
export const MINIMALISM_RADII = { chrome: 9, pinned: 9 } as const;
export const MINIMALISM_HIDDEN: readonly ChromePart[] = ["addressField", "navButtons", "sidebarButton", "downloads", "profile"];

const looks = new WeakMap<ThemeLook, ThemeLook>();

const unlessThemed = (theirs: number, ours: number, base: number) => (theirs === base ? ours : theirs);

export function minimalismLookOf(look: ThemeLook): ThemeLook {
  let made = looks.get(look);
  if (made) return made;
  made = {
    ...look,
    metrics: {
      rowHeight: unlessThemed(look.metrics.rowHeight, MINIMALISM_METRICS.rowHeight, ROW_METRICS.rowHeight),
      rowGap: unlessThemed(look.metrics.rowGap, MINIMALISM_METRICS.rowGap, ROW_METRICS.rowGap),
      pinnedHeight: unlessThemed(look.metrics.pinnedHeight, MINIMALISM_METRICS.pinnedHeight, ROW_METRICS.pinnedHeight),
    },
    radii: {
      ...look.radii,
      chrome: unlessThemed(look.radii.chrome, MINIMALISM_RADII.chrome, RADII.chrome),
      pinned: unlessThemed(look.radii.pinned, MINIMALISM_RADII.pinned, RADII.pinned),
    },
    hidden: new Set([...look.hidden, ...MINIMALISM_HIDDEN]),
  };
  looks.set(look, made);
  return made;
}
