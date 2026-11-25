export function wholeRowsHeight(bottoms: readonly number[], room: number): number | null {
  if (room <= 0) return null;
  let fitting = 0;
  for (const bottom of bottoms) {
    if (bottom <= 0) return null;
    if (bottom > room) return fitting > 0 ? fitting : null;
    fitting = Math.max(fitting, bottom);
  }
  return null;
}

export const ROW_FADE = { from: 0.7, floor: 0.15, overflowSlack: 0.5 } as const;

export const rowsFadeEdge = (room: number) => ({ length: room * (1 - ROW_FADE.from), floor: ROW_FADE.floor });

export const rowsOverflow = (lastBottom: number, room: number): boolean => room > 0 && lastBottom > room + ROW_FADE.overflowSlack;

export function rowFade(top: number, bottom: number, room: number, overflows: boolean): number {
  if (!overflows || room <= 0) return 1;
  const visibleBottom = Math.min(bottom, room);
  if (visibleBottom <= top) return ROW_FADE.floor;
  const middle = (top + visibleBottom) / 2;
  const start = room * ROW_FADE.from;
  if (middle <= start) return 1;
  return 1 - (1 - ROW_FADE.floor) * Math.min(1, (middle - start) / (room - start));
}
