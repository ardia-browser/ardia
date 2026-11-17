import { create } from "zustand";

export type ScreenColumn = { edge: "leading" | "trailing"; inset: number };

export type ScreenFold = { top: number; bottom: number };

export type ScreenLayout = { name: "phone" } | { name: "column"; column: ScreenColumn } | { name: "wide" } | { name: "split"; fold: ScreenFold };

export type ScreenLayoutSource = {
  layout: "phone" | "column" | "wide" | "split";
  column?: { edge: "leading" | "trailing"; inset: number };
  fold?: { top: number; bottom: number };
  canvas?: { width: number; height: number } | null;
};

export type DuoCanvasSize = { width: number; height: number };

export const DUO_CANVAS = { radius: 40 } as const;

export const PHONE_LAYOUT: ScreenLayout = { name: "phone" };

export const SCREEN_COLUMN = { axis: 48, top: 166, button: 48, spacing: 7, fieldSide: 12, fieldTop: 245 } as const;

export function screenLayoutOf(report: ScreenLayoutSource | null): ScreenLayout {
  if (!report) return PHONE_LAYOUT;
  if (report.layout === "column" && report.column) return { name: "column", column: { edge: report.column.edge, inset: report.column.inset } };
  if (report.layout === "split" && report.fold) return { name: "split", fold: { top: report.fold.top, bottom: report.fold.bottom } };
  if (report.layout === "wide") return { name: "wide" };
  return PHONE_LAYOUT;
}

export const sameScreenLayout = (a: ScreenLayout, b: ScreenLayout) => {
  if (a.name !== b.name) return false;
  if (a.name === "column" && b.name === "column") return a.column.edge === b.column.edge && a.column.inset === b.column.inset;
  if (a.name === "split" && b.name === "split") return a.fold.top === b.fold.top && a.fold.bottom === b.fold.bottom;
  return true;
};

export const columnContentWidth = (column: ScreenColumn, width: number) => Math.max(width - column.inset, 0);

export const columnCenterX = (column: ScreenColumn, width: number) => {
  const fromEdge = Math.min(SCREEN_COLUMN.axis, column.inset - SCREEN_COLUMN.button / 2);
  return column.edge === "trailing" ? width - fromEdge : fromEdge;
};

export const columnContentLeft = (column: ScreenColumn) => (column.edge === "leading" ? column.inset : 0);

export const useScreenLayout = create<{ layout: ScreenLayout; canvas: DuoCanvasSize | null }>(() => ({ layout: PHONE_LAYOUT, canvas: null }));

export function reportScreenLayout(report: ScreenLayoutSource | null) {
  const next = screenLayoutOf(report);
  const canvas = report?.canvas ? { width: report.canvas.width, height: report.canvas.height } : null;
  const now = useScreenLayout.getState();
  const sameCanvas = now.canvas === canvas || (now.canvas !== null && canvas !== null && now.canvas.width === canvas.width && now.canvas.height === canvas.height);
  if (sameScreenLayout(now.layout, next) && sameCanvas) return;
  useScreenLayout.setState({ layout: sameScreenLayout(now.layout, next) ? now.layout : next, canvas: sameCanvas ? now.canvas : canvas });
}

export const currentScreenLayout = () => useScreenLayout.getState().layout;
