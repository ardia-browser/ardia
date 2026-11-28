import { ICON_STRIP } from "../../lib/windowLayout";
import type { Frame } from "./dragModel";

export { ICON_STRIP };

export const ICONS_SNAP = 40;

export const stripInset = (ICON_STRIP.width - ICON_STRIP.square) / 2;

export const stripPitch = ICON_STRIP.square + ICON_STRIP.gap;

export const stripExpandSnap = ICON_STRIP.width + ICONS_SNAP;

export const stripRail = (cardTop: number, cardBottom: number) => ({ top: Math.round(cardTop), bottom: Math.round(cardBottom) });

export const stripBand = (draggingTab: boolean, edgeBand: number) => (draggingTab ? ICON_STRIP.width : edgeBand);

export function handoffPoint(row: Frame | null, pointer: { x: number; y: number }, right = false): { x: number; y: number } {
  if (!row) return pointer;
  const fromEdge = Math.min(row.w / 2, ICON_STRIP.square / 2 + stripInset);
  return { x: right ? row.x + row.w - fromEdge : row.x + fromEdge, y: row.y + row.h / 2 };
}

export function stripPointerOver(x: number, right: boolean, windowWidth: number): boolean {
  return right ? x >= windowWidth - ICON_STRIP.width : x < ICON_STRIP.width;
}

export const STRIP_DIVIDER_HEIGHT = 1 + ICON_STRIP.gap * 2;

export type StripLayoutItem = { divider: boolean; bars: readonly { group: string }[] };

export function stripLayout(items: readonly StripLayoutItem[], railTop: number): { tops: number[]; end: number } {
  let next = railTop;
  let before: readonly { group: string }[] = [];
  const tops = items.map(({ divider, bars }) => {
    if (divider) {
      const top = next;
      next = top + STRIP_DIVIDER_HEIGHT;
      before = [];
      return top;
    }
    if (bars.length && before.length && bars[0]!.group !== before[0]!.group) next += ICON_STRIP.gap;
    const top = next;
    next = top + ICON_STRIP.square + ICON_STRIP.gap;
    before = bars;
    return top;
  });
  return { tops, end: next };
}

export type BarSpan = { group: string; color: string | null; depth: number; top: number; bottom: number };

const BAR_CAP_INSET = 3;

export function stripBarSpans(items: readonly { bars: readonly { group: string; color: string | null }[] }[], tops: readonly number[]): BarSpan[] {
  const spans = new Map<string, BarSpan>();
  items.forEach(({ bars }, i) =>
    bars.forEach((bar, depth) => {
      const bottom = tops[i]! + ICON_STRIP.square - BAR_CAP_INSET;
      const span = spans.get(bar.group);
      if (span) span.bottom = bottom;
      else spans.set(bar.group, { group: bar.group, color: bar.color, depth, top: tops[i]! + BAR_CAP_INSET, bottom });
    }),
  );
  return [...spans.values()].sort((a, b) => a.depth - b.depth);
}
