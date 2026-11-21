import type { MotionCurve } from "@ardia/phone-native";
import { spring } from "../ui/motion";

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
  closeCircle: 24,
  closeHit: { width: 36, height: 30 },
  closeGlyph: 13.2,
  selectedEdge: 2.5,
  edge: 0.5,
  pressedScale: 0.94,
} as const;

export const tabGridInk = { shadow: "0px 3px 20px rgba(0,0,0,0.108)" } as const;

const crossfade: MotionCurve = { type: "spring", response: 0.18, dampingFraction: 1 };
const crossfadeReduced: MotionCurve = { type: "timing", durationMs: 150, curve: [0, 0, 0.58, 1] };

export const tabGridMotion = { press: spring(0.16, 1), reflow: spring(0.22, 1), crossfade, crossfadeReduced } as const;

export type TabGridInsets = { top: number; bottom: number; side: number };

export type TabGridColumns = { count: number; width: number };

export function tabGridColumns(available: number): TabGridColumns {
  const { columnMin, columnMax, columnSpacing } = tabGridLayout;
  const count = Math.max(1, Math.floor((available + columnSpacing) / (columnMin + columnSpacing)));
  const width = Math.min(columnMax, Math.max(0, (available - columnSpacing * (count - 1)) / count));
  return { count, width };
}

export const tabGridRowHeight = (columnWidth: number, aspect: number) => tabGridLayout.closeHit.height + tabGridLayout.cellSpacing + columnWidth / Math.max(aspect, 0.01);

export function tabGridInsets(safeTop: number, chromeBottom: number, height: number, barCenterY: number, barCircle: number, chromeSide: number): TabGridInsets {
  return { top: safeTop + chromeBottom + tabGridLayout.belowHeader, bottom: height - barCenterY + barCircle, side: chromeSide + tabGridLayout.sideExtra };
}

export function tabGridStartOffset(index: number, count: number, columns: number, rowHeight: number, viewport: number, bottomInset: number): number {
  if (index < 0 || count === 0) return 0;
  const rows = Math.ceil(count / columns);
  const content = tabGridLayout.topFade + rows * rowHeight + Math.max(rows - 1, 0) * tabGridLayout.rowSpacing + bottomInset;
  const row = Math.floor(index / columns);
  const center = tabGridLayout.topFade + row * (rowHeight + tabGridLayout.rowSpacing) + rowHeight / 2;
  return Math.min(Math.max(center - viewport / 2, 0), Math.max(content - viewport, 0));
}

export const centredGridOffset = (cellY: number, cellHeight: number, viewport: number, content: number) => Math.min(Math.max(cellY + cellHeight / 2 - viewport / 2, 0), Math.max(content - viewport, 0));
