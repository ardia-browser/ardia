export type MenuScrollSpan = { start: number; end: number };
export type MenuScrollView = { top: number; room: number; content: number; inset: number };

export function scrollToKeep(row: MenuScrollSpan, view: MenuScrollView): number | null {
  const want = { start: row.start - view.inset, end: row.end + view.inset };
  const most = Math.max(0, view.content - view.room);
  const clamp = (y: number) => Math.min(most, Math.max(0, y));
  if (want.start < view.top) return clamp(want.start);
  if (want.end > view.top + view.room) return clamp(want.end - view.room);
  return null;
}
