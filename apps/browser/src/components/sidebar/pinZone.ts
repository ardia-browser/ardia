import { SQUARE_TILE_COLUMNS, TOP_APP_TILE_GAP as TILE_GAP } from "../../lib/windowLayout";

export { TILE_GAP };
const MIN_TILE = 50;
const BALANCED_MAX_COLUMNS = 4;
export const PIN_ZONE_HYSTERESIS = 6;

type Area = { x: number; y: number; w: number };

function gridColumns(count: number, innerWidth: number, balanced: boolean) {
  const fit = Math.max(1, Math.floor((innerWidth + TILE_GAP) / (MIN_TILE + TILE_GAP)));
  if (!balanced) return Math.min(count || 1, fit);
  const rows = Math.ceil((count || 1) / Math.min(BALANCED_MAX_COLUMNS, fit));
  return Math.ceil((count || 1) / rows);
}

export function pinGrid(count: number, innerWidth: number, balanced = false, square = false) {
  const columns = square ? SQUARE_TILE_COLUMNS : gridColumns(count, innerWidth, balanced);
  const width = Math.floor(((innerWidth - TILE_GAP * (columns - 1)) / columns) * 2) / 2;
  return { columns, width };
}

export function pinLayout(count: number, innerWidth: number, fixedHeight: number, balanced = false, square = false) {
  const { columns, width } = pinGrid(count, innerWidth, balanced, square);
  const height = square ? width : fixedHeight;
  const rows = Math.max(1, Math.ceil(count / columns));
  const pitch = height + TILE_GAP;
  return { columns, width, height, pitch, gridHeight: rows * pitch - TILE_GAP };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function pinSlot(grid: Area, count: number, tiles: ReturnType<typeof pinLayout>, x: number, y: number): number {
  const { columns, width, pitch } = tiles;
  const rows = Math.max(1, Math.ceil(count / columns));
  const row = clamp(Math.floor((y - grid.y + TILE_GAP / 2) / pitch), 0, rows - 1);
  const column = clamp(Math.floor((x - grid.x + TILE_GAP / 2) / (width + TILE_GAP)), 0, columns - 1);
  return clamp(row * columns + column, 0, Math.max(0, count - 1));
}

export function overPins(y: number, listTop: number, wasOver: boolean, hysteresis = PIN_ZONE_HYSTERESIS): boolean {
  return y < listTop + (wasOver ? hysteresis : -hysteresis);
}
