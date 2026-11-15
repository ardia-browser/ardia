export type RowSelection = { selected: ReadonlySet<string>; anchor: string | null; cursor: string | null };

export const NO_ROWS_SELECTED: RowSelection = { selected: new Set(), anchor: null, cursor: null };

function rangeOf(urls: readonly string[], from: number, to: number): string[] {
  return urls.slice(Math.min(from, to), Math.max(from, to) + 1);
}

function movedRange(urls: readonly string[], s: RowSelection, anchor: string, to: number): RowSelection {
  const from = urls.indexOf(anchor);
  const end = s.cursor && urls.includes(s.cursor) ? urls.indexOf(s.cursor) : from;
  const selected = new Set(s.selected);
  for (const url of rangeOf(urls, from, end)) selected.delete(url);
  for (const url of rangeOf(urls, from, to)) selected.add(url);
  return { selected, anchor, cursor: urls[to]! };
}

export function toggledRow(urls: readonly string[], s: RowSelection, url: string, shift: boolean): RowSelection {
  const to = urls.indexOf(url);
  if (shift && s.anchor && urls.includes(s.anchor) && to >= 0) return movedRange(urls, s, s.anchor, to);
  const selected = new Set(s.selected);
  if (selected.has(url)) selected.delete(url);
  else selected.add(url);
  return { selected, anchor: url, cursor: url };
}

export function movedCursor(urls: readonly string[], s: RowSelection, step: 1 | -1, extend: boolean): RowSelection {
  if (!urls.length) return s;
  const at = s.cursor ? urls.indexOf(s.cursor) : -1;
  const index = at < 0 ? (step > 0 ? 0 : urls.length - 1) : Math.max(0, Math.min(urls.length - 1, at + step));
  const cursor = urls[index]!;
  if (!extend) return { ...s, anchor: cursor, cursor };
  const anchor = s.anchor && urls.includes(s.anchor) ? s.anchor : at >= 0 ? urls[at]! : cursor;
  return movedRange(urls, anchor === s.anchor ? s : { ...s, cursor: anchor }, anchor, index);
}

export const toggledCursor = (urls: readonly string[], s: RowSelection): RowSelection => (s.cursor && urls.includes(s.cursor) ? toggledRow(urls, s, s.cursor, false) : s);

export const allRows = (urls: readonly string[], s: RowSelection): RowSelection => ({ ...s, selected: new Set(urls) });

export function shownRows(urls: readonly string[], s: RowSelection): RowSelection {
  const shown = new Set(urls);
  const kept = [...s.selected].filter((url) => shown.has(url));
  const cursor = s.cursor && shown.has(s.cursor) ? s.cursor : null;
  const anchor = s.anchor && shown.has(s.anchor) ? s.anchor : null;
  if (kept.length === s.selected.size && cursor === s.cursor && anchor === s.anchor) return s;
  return { selected: kept.length === s.selected.size ? s.selected : new Set(kept), anchor, cursor };
}

export const withoutRows = (s: RowSelection, urls: readonly string[]): RowSelection =>
  urls.some((url) => s.selected.has(url)) ? { ...s, selected: new Set([...s.selected].filter((url) => !urls.includes(url))) } : s;
