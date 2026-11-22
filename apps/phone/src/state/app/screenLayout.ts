import { create } from "zustand";
import type { ScreenHinge } from "../../lib/bottomBarSpan";

export type { ScreenHinge };

export type ScreenFold = { top: number; bottom: number };

export type ScreenLayout = { name: "phone" } | { name: "wide" } | { name: "split"; fold: ScreenFold };

export type ScreenLayoutSource = {
  layout: "phone" | "wide" | "split";
  space?: { hinge?: ScreenHinge };
  fold?: { top: number; bottom: number };
  canvas?: { width: number; height: number } | null;
};

export type DuoCanvasSize = { width: number; height: number };

export const DUO_CANVAS = { radius: 40 } as const;

export const PHONE_LAYOUT: ScreenLayout = { name: "phone" };

export function screenLayoutOf(report: ScreenLayoutSource | null): ScreenLayout {
  if (!report) return PHONE_LAYOUT;
  if (report.layout === "split" && report.fold) return { name: "split", fold: { top: report.fold.top, bottom: report.fold.bottom } };
  if (report.layout === "wide") return { name: "wide" };
  return PHONE_LAYOUT;
}

export const sameScreenLayout = (a: ScreenLayout, b: ScreenLayout) => {
  if (a.name !== b.name) return false;
  if (a.name === "split" && b.name === "split") return a.fold.top === b.fold.top && a.fold.bottom === b.fold.bottom;
  return true;
};

export const useScreenLayout = create<{ layout: ScreenLayout; canvas: DuoCanvasSize | null; hinge: ScreenHinge }>(() => ({ layout: PHONE_LAYOUT, canvas: null, hinge: "none" }));

export function reportScreenLayout(report: ScreenLayoutSource | null) {
  const next = screenLayoutOf(report);
  const canvas = report?.canvas ? { width: report.canvas.width, height: report.canvas.height } : null;
  const hinge = report?.space?.hinge ?? "none";
  const now = useScreenLayout.getState();
  const sameCanvas = now.canvas === canvas || (now.canvas !== null && canvas !== null && now.canvas.width === canvas.width && now.canvas.height === canvas.height);
  if (sameScreenLayout(now.layout, next) && sameCanvas && now.hinge === hinge) return;
  useScreenLayout.setState({ layout: sameScreenLayout(now.layout, next) ? now.layout : next, canvas: sameCanvas ? now.canvas : canvas, hinge });
}

export const currentScreenLayout = () => useScreenLayout.getState().layout;
