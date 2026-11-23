import { EDGE_FADE, EDGE_FADE_FLOOR, EDGE_FADE_ONSET } from "./tokens";

type EdgeStrength = { left: number; right: number };

const ramp = (x: number) => Math.max(0, Math.min(1, x));

export function edgeStrength(scroll: number, viewport: number, content: number): EdgeStrength {
  const last = Math.max(0, content - viewport);
  return { left: ramp(scroll / EDGE_FADE_ONSET), right: ramp((last - scroll) / EDGE_FADE_ONSET) };
}

export function edgeMaskAt(x: number, width: number, { left, right }: EdgeStrength): number {
  const fromLeft = ramp(1 - x / EDGE_FADE) * left;
  const fromRight = ramp(1 - (width - x) / EDGE_FADE) * right;
  return 1 - (1 - EDGE_FADE_FLOOR) * Math.min(1, fromLeft + fromRight);
}

export function edgeMaskGradient(width: number, { left, right }: EdgeStrength): { alphas: number[]; stops: number[] } {
  const edge = width > 0 ? Math.min(0.5, EDGE_FADE / width) : 0.5;
  return { alphas: [1 - (1 - EDGE_FADE_FLOOR) * left, 1, 1, 1 - (1 - EDGE_FADE_FLOOR) * right], stops: [0, edge, 1 - edge, 1] };
}
