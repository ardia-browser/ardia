import { hairline, space } from "../ui/tokens";

export const ICON_PICKER = {
  columns: 9,
  cell: 32,
  rows: 7,
  header: 26,
  emoji: 20,
  symbol: 15,
  symbolBox: 20,
  pad: space.m,
  anchorGap: 6,
  windowMargin: 8,
  sidebarGap: 6,
  selectedRing: 1.5,
} as const;

export const ICON_PICKER_WIDTH = ICON_PICKER.columns * ICON_PICKER.cell + ICON_PICKER.pad * 2 + hairline.panel * 2;
