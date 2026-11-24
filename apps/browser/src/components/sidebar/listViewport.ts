type ListBand = { top: number; bottom: number };

export type ListViewport = { band: () => ListBand | null };

export const shiftedBand = (band: ListBand | null, by: number): ListBand | null => (band ? { top: band.top - by, bottom: band.bottom - by } : null);

export const withOverscan = (top: number, viewport: number): ListBand => ({ top: top - viewport, bottom: top + 2 * viewport });

export function seenSliding(top: number, height: number, from: number, band: ListBand | null): boolean {
  if (!band) return true;
  const start = Math.min(top, top + from);
  const end = Math.max(top, top + from) + height;
  return end > band.top && start < band.bottom;
}
