import { SMALL_BAR_BUTTON } from "../littleArdia/tokens";
import { space } from "../ui/tokens";
import type { PeekButtons } from "../../state/settings/settings";

const INSET_FRACTION = 0.055;
const MIN_INSET = 16;

export const PEEK_SIDE_GAP = space.m;
const SIDE_ROOM = SMALL_BAR_BUTTON + 2 * PEEK_SIDE_GAP;

export function peekFrame(width: number, height: number, buttons: PeekButtons = "top") {
  const x = Math.max(MIN_INSET, Math.round(width * INSET_FRACTION));
  const y = Math.max(MIN_INSET, Math.round(height * INSET_FRACTION));
  const left = buttons === "left" ? Math.max(x, SIDE_ROOM) : x;
  const right = buttons === "right" ? Math.max(x, SIDE_ROOM) : x;
  return { left, top: y, width: Math.max(0, width - left - right), height: Math.max(0, height - 2 * y) };
}
