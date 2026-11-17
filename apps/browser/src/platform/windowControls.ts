import type { CaptionRegion } from "@ardia/shell";

export type { CaptionRegion };

export type PageRounding = { radius: number; corners: readonly [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number] };

export type WindowControls = {
  minimize(windowId: string): void;
  toggleMaximize(windowId: string): void;
  setCaptionRegions(windowId: string, regions: readonly CaptionRegion[]): void;
  setPageRounding(windowId: string, rounding: PageRounding): void;
};

export const windowControls: WindowControls = {
  minimize() {},
  toggleMaximize() {},
  setCaptionRegions() {},
  setPageRounding() {},
};
