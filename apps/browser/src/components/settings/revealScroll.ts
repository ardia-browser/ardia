import { settingsReveal } from "./tokens";

export type RevealGeometry = {
  rowTop: number;
  rowHeight: number;
  headerTop: number | null;
  headerTops: number[];
  scrollTop: number;
  viewport: number;
  contentHeight: number;
};

const textTopOf = (headerTop: number) => headerTop + settingsReveal.headerGap;

export function revealOffset({ rowTop, rowHeight, headerTop, headerTops, scrollTop, viewport, contentHeight }: RevealGeometry): number | null {
  const rowBottom = rowTop + rowHeight;
  const fitsBelow = (offset: number) => rowBottom <= offset + viewport - settingsReveal.margin;
  const headerText = headerTop === null ? null : Math.min(textTopOf(headerTop), rowTop);
  const start = headerText !== null && fitsBelow(headerText - settingsReveal.inset) ? headerText : rowTop;
  if (start >= scrollTop + settingsReveal.inset && fitsBelow(scrollTop)) return null;
  const end = Math.max(0, contentHeight - viewport);
  const wanted = Math.max(0, start - settingsReveal.inset);
  if (wanted <= end) return wanted;
  const stops = headerTops
    .map((top) => textTopOf(top) - settingsReveal.inset)
    .filter((offset) => offset >= 0 && offset <= end && rowTop >= offset + settingsReveal.inset && fitsBelow(offset));
  return stops.length ? Math.max(...stops) : end;
}
