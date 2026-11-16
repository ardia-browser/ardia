import { finite } from "./numbers";

export const SMALLEST_GRAIN_CELL = 0.25;
export const LARGEST_GRAIN_CELL = 4;

export const grainCellOf = (scale: unknown): number => Math.min(LARGEST_GRAIN_CELL, Math.max(SMALLEST_GRAIN_CELL, finite(scale, 1)));
