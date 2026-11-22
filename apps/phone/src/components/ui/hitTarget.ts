import { targetMinimum } from "./targetTokens.ts";

export type SlotInsets = { top: number; bottom: number; left: number; right: number };

export type SlotBox = { width: number; height: number; alignItems: "center"; justifyContent: "center" };

export const slotSide = (visual: number, minimum: number = targetMinimum) => Math.max(visual, minimum);

export function slotAround(width: number, height: number = width, minimum: number = targetMinimum): SlotBox {
  return { width: slotSide(width, minimum), height: slotSide(height, minimum), alignItems: "center", justifyContent: "center" };
}

export function slopToReach(width: number, height: number = width, minimum: number = targetMinimum): SlotInsets {
  const across = Math.max(0, (minimum - width) / 2);
  const down = Math.max(0, (minimum - height) / 2);
  return { top: down, bottom: down, left: across, right: across };
}

export const reachesTarget = (width: number, height: number, slop: SlotInsets = { top: 0, bottom: 0, left: 0, right: 0 }, minimum: number = targetMinimum) =>
  width + slop.left + slop.right >= minimum && height + slop.top + slop.bottom >= minimum;
