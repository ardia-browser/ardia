export type RowFrame = { left: number; top: number; right: number; bottom: number };

export const SCRUB = { slack: 8, distance: 6, refineWidth: 40 } as const;

export type ScrubState = { highlighted: number; scrubbing: boolean; startX: number; startY: number };

export type ScrubRelease = { kind: "nothing" } | { kind: "activate"; index: number; wasScrubbing: boolean };

export const idleScrub: ScrubState = { highlighted: -1, scrubbing: false, startX: 0, startY: 0 };

export function rowAt(frames: readonly (RowFrame | null | undefined)[], x: number, y: number, slack?: number): number {
  "worklet";
  const side = slack ?? SCRUB.slack;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!frame || frame.bottom <= frame.top) continue;
    if (frame.top <= y && y < frame.bottom && frame.left - side <= x && x <= frame.right + side) return index;
  }
  return -1;
}

export function scrubBegin(frames: readonly (RowFrame | null | undefined)[], x: number, y: number): ScrubState {
  "worklet";
  return { highlighted: rowAt(frames, x, y), scrubbing: false, startX: x, startY: y };
}

export function scrubMove(
  state: ScrubState,
  frames: readonly (RowFrame | null | undefined)[],
  x: number,
  y: number,
): { state: ScrubState; ticks: boolean } {
  "worklet";
  const scrubbing = state.scrubbing || Math.abs(y - state.startY) > SCRUB.distance || Math.abs(x - state.startX) > SCRUB.distance;
  const hit = rowAt(frames, x, y);
  if (hit === state.highlighted) return { state: { ...state, scrubbing }, ticks: false };
  return { state: { ...state, scrubbing, highlighted: hit }, ticks: scrubbing && hit !== -1 };
}

export function scrubEnd(state: ScrubState, frames: readonly (RowFrame | null | undefined)[], x: number, y: number): ScrubRelease {
  "worklet";
  const hit = rowAt(frames, x, y);
  if (hit === -1) return { kind: "nothing" };
  return { kind: "activate", index: hit, wasScrubbing: state.scrubbing };
}

export function releaseRefines(release: ScrubRelease, frames: readonly (RowFrame | null | undefined)[], x: number, refinable: boolean): boolean {
  "worklet";
  if (release.kind !== "activate" || release.wasScrubbing || !refinable) return false;
  const frame = frames[release.index];
  return Boolean(frame) && x >= frame!.right - SCRUB.refineWidth;
}
