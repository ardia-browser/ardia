import { rubberBand, TRAY_DRAG, trayDragDismisses } from "./trayMotion.ts";

export const SHEET_HALF_SHARE = 0.5;
export const SHEET_DETENT_FLICK = 500;

export type SheetDetent = "full" | "half" | "dismiss";

export function sheetHalfRest(fullHeight: number, screenHeight: number): number {
  "worklet";
  return Math.max(fullHeight - screenHeight * SHEET_HALF_SHARE, 0);
}

export function halfSheetPosition(rest: number, translation: number): number {
  "worklet";
  const position = rest + translation;
  return position >= 0 ? position : -rubberBand(-position, TRAY_DRAG.upwardLimit);
}

export function sheetDetentAfterDrag(position: number, velocity: number, halfRest: number, halfHeight: number): SheetDetent {
  "worklet";
  if (position > halfRest) return trayDragDismisses(position - halfRest, velocity, halfHeight) ? "dismiss" : "half";
  if (velocity <= -SHEET_DETENT_FLICK) return "full";
  if (velocity >= SHEET_DETENT_FLICK) return "half";
  return position + velocity * TRAY_DRAG.momentum < halfRest / 2 ? "full" : "half";
}
