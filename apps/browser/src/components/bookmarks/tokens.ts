import { capsule, radius, space } from "../ui/tokens";

export const folderTreeInk = { selectedChevron: "#FFFFFFCC" } as const;

export const folderTree = { indent: 16, inset: space.xs, chevronBox: 16, chevron: 9, folderIcon: 13, folderBox: 18, check: 11, checkBox: 14, checkInset: space.s, plus: 11 } as const;

export const folderPicker = { row: 28, rowGap: space.xxs, shownRows: 6.5 } as const;

export const bookmarkDialog = { belowField: space.xs, belowToolbar: space.xxs, rightInset: space.ml } as const;

export const bookmarkDrag = { start: 4, line: 2, lineRadius: capsule(2) } as const;

export const bookmarksBar = {
  overflowWidth: 28,
  dividerHeight: 14,
  dropLineInset: space.xs,
  dropRing: 1.5,
  ghostOpacity: 0.92,
} as const;

export type BarSize = {
  height: number;
  item: number;
  itemMaxWidth: number;
  itemGap: number;
  padding: number;
  titleGap: number;
  radius: number;
  favicon: number;
  icon: number;
  iconBox: number;
  text: "small" | "body";
  menuWidth: number;
  menuRow: number;
};

export const barSizes: Record<"default", BarSize> = {
  default: { height: 30, item: 24, itemMaxWidth: 190, itemGap: 0, padding: space.m, titleGap: space.s, get radius() { return radius.control; }, favicon: 14, icon: 12, iconBox: 16, text: "small", menuWidth: 260, menuRow: 28 },
};

export const folderMenu = { offsetY: space.xs, cascadeOverlap: space.xs, hoverOpenMs: 160, margin: space.m, favicon: 16, chevronBox: 12 } as const;
