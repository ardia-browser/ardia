import { contrastRatio, mix, over } from "../../lib/color";

export const READABLE_TEXT = 4.5;
const STEPS = 50;

export function readableInk(color: string, ground: string, toward: string, min = READABLE_TEXT): string {
  for (let step = 0; step <= STEPS; step += 1) {
    const ink = mix(color, toward, step / STEPS);
    if (contrastRatio(ink, ground) >= min) return ink;
  }
  return toward;
}

export const groupGround = (groupFill: string, pane: string) => over(groupFill, pane);
