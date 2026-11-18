import { createContext } from "react";

export type StripScroll = {
  active(): boolean;
  offset(): number;
  max(): number;
  scrollTo(x: number): void;
  measure(done: (x: number, width: number) => void): void;
};

export const StripScrollContext = createContext<StripScroll | null>(null);

export function autoScrollSpeed(pointer: number, [left, right]: readonly [number, number], offset: number, max: number, zone: number, top: number): number {
  const into = (depth: number) => top * Math.min(1, Math.max(0, depth) / zone);
  if (pointer < left + zone && offset > 0.5) return -Math.max(1, into(left + zone - pointer));
  if (pointer > right - zone && offset < max - 0.5) return Math.max(1, into(pointer - (right - zone)));
  return 0;
}
