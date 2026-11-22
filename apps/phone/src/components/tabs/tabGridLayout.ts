import type { MotionCurve } from "@ardia/phone-native";
import { spring } from "../ui/motion";
import { targetMinimum } from "../ui/targetTokens";

export const tabGridLayout = {
  columnMin: 150,
  columnMax: 260,
  columnSpacing: 14,
  rowSpacing: 18,
  topFade: 14,
  belowHeader: 8,
  sideExtra: 4,
  cellSpacing: 8,
  headerSpacing: 6,
  closePlate: 24,
  closeHit: { width: 36, height: 30 },
  closeGlyph: 13.2,
  selectedEdge: 2.5,
} as const;

const closeReach = (targetMinimum - tabGridLayout.closeHit.height) / 2;

export const tabGridCloseSlot = {
  side: targetMinimum,
  reach: closeReach,
  lead: tabGridLayout.closeHit.width - targetMinimum,
  cellSpacing: tabGridLayout.cellSpacing - closeReach,
  rowSpacing: tabGridLayout.rowSpacing - closeReach,
  topPadding: tabGridLayout.topFade - closeReach,
} as const;

const crossfade: MotionCurve = { type: "spring", response: 0.18, dampingFraction: 1 };
const crossfadeReduced: MotionCurve = { type: "timing", durationMs: 150, curve: [0, 0, 0.58, 1] };

export const tabGridMotion = { reflow: spring(0.22, 1), crossfade, crossfadeReduced } as const;

export type TabGridInsets = { top: number; bottom: number; side: number };

export type TabGridColumns = { count: number; width: number };

export function tabGridColumns(available: number): TabGridColumns {
  const { columnMin, columnMax, columnSpacing } = tabGridLayout;
  const count = Math.max(1, Math.floor((available + columnSpacing) / (columnMin + columnSpacing)));
  const width = Math.min(columnMax, Math.max(0, (available - columnSpacing * (count - 1)) / count));
  return { count, width };
}

export const tabGridRowHeight = (columnWidth: number, aspect: number) => tabGridCloseSlot.side + tabGridCloseSlot.cellSpacing + columnWidth / Math.max(aspect, 0.01);

export function tabGridInsets(safeTop: number, chromeBottom: number, height: number, barCenterY: number, barCircle: number, chromeSide: number): TabGridInsets {
  return { top: safeTop + chromeBottom + tabGridLayout.belowHeader, bottom: height - barCenterY + barCircle, side: chromeSide + tabGridLayout.sideExtra };
}

export function tabGridStartOffset(index: number, count: number, columns: number, rowHeight: number, viewport: number, bottomInset: number): number {
  if (index < 0 || count === 0) return 0;
  const rows = Math.ceil(count / columns);
  const content = tabGridCloseSlot.topPadding + rows * rowHeight + Math.max(rows - 1, 0) * tabGridCloseSlot.rowSpacing + bottomInset;
  const row = Math.floor(index / columns);
  const center = tabGridCloseSlot.topPadding + row * (rowHeight + tabGridCloseSlot.rowSpacing) + tabGridCloseSlot.reach + (rowHeight - tabGridCloseSlot.reach) / 2;
  return Math.min(Math.max(center - viewport / 2, 0), Math.max(content - viewport, 0));
}

export const centredGridOffset = (cellY: number, cellHeight: number, viewport: number, content: number) => {
  const shownTop = cellY + tabGridCloseSlot.reach;
  const shownHeight = cellHeight - tabGridCloseSlot.reach;
  return Math.min(Math.max(shownTop + shownHeight / 2 - viewport / 2, 0), Math.max(content - viewport, 0));
};
