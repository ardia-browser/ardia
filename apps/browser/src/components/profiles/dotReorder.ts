export type DotDrag = { shift: number; to: number };

const lefts = (widths: number[]) => widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w, 0));

export function dotDrag(widths: number[], from: number, dx: number): DotDrag {
  const starts = lefts(widths);
  const width = widths[from] ?? 0;
  const start = starts[from] ?? 0;
  const total = widths.reduce((sum, w) => sum + w, 0);
  const shift = Math.max(-start, Math.min(total - start - width, dx));
  const center = start + width / 2 + shift;
  const passed = (j: number, w: number) => (j < from ? starts[j]! + w / 2 < center : starts[j]! + w / 2 <= center);
  const to = widths.filter((w, j) => j !== from && passed(j, w)).length;
  return { shift, to };
}

export function dotShifts(widths: number[], from: number, to: number): number[] {
  const gap = widths[from] ?? 0;
  return widths.map((_, j) => (j === from ? 0 : from < j && j <= to ? -gap : to <= j && j < from ? gap : 0));
}

export function movedOrder(ids: string[], from: number, to: number): string[] {
  const id = ids[from];
  if (id === undefined || from === to) return ids;
  const rest = ids.filter((_, i) => i !== from);
  rest.splice(to, 0, id);
  return rest;
}
