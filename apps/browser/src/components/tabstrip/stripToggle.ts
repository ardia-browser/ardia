import { TAIL_EXPANDED } from "./stripGroups";
import { GROUP_TITLE_GAP } from "./tokens";

export const GROUP_NAME_INSET = 2;
const CLIP_TAIL = TAIL_EXPANDED - 2.25;
export const TOGGLE_MS = 180;
export const toggleEase = (t: number) => 1 - (1 - t) ** 3;

export function groupChipWidth(frame: number | undefined, natural: number | undefined, cap: number): number | undefined {
  if (frame === undefined) return undefined;
  return frame + GROUP_TITLE_GAP - GROUP_NAME_INSET + (natural === undefined ? 0 : Math.min(natural, cap) + GROUP_NAME_INSET * 2);
}

export const memberClipEdge = (pill: number) => pill - CLIP_TAIL;

export type MemberFrame = { left: number; shown: number; content: number };

export function revealedMembers(start: number, offsets: readonly number[], widths: readonly number[], pill: number): MemberFrame[] {
  const edge = memberClipEdge(pill);
  return widths.map((content, i) => {
    const left = start + offsets[i]!;
    return { left, content, shown: Math.max(0, Math.min(content, edge - left)) };
  });
}

export const toggleFrame = (from: number, to: number, t: number) => from + (to - from) * toggleEase(Math.max(0, Math.min(1, t)));
