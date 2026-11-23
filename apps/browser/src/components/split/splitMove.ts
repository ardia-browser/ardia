import type { SplitView } from "../../state/browser/types";
import { horizontalNeighbor, verticalNeighbor } from "../../state/splits/reorder";
import { STRIP_HEIGHT } from "../../state/windows/toolbarAutoHide";
import type { Rect } from "../window/geometry";
import type { CardChrome } from "../window/paneChrome";
import { MOVE_HANDLE } from "./tokens";

export type Point = { x: number; y: number };

export function paneTopChrome(o: { chrome: CardChrome; toolbarHeight: number; collapsed: boolean; topBarHeight: number; shareBarHeight?: number }): number {
  const share = o.shareBarHeight ?? 0;
  if (o.chrome.kind === "pane") return (o.chrome.autoHide && o.collapsed ? STRIP_HEIGHT : o.toolbarHeight) + share;
  if (o.chrome.kind === "none") return o.topBarHeight + share;
  return share;
}

export function handleOrigin(rect: Rect, topChrome: number, inset = MOVE_HANDLE.inset): Point {
  return { x: rect.x + inset, y: rect.y + topChrome + inset };
}

const contains = (rect: Rect, x: number, y: number) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

const distanceToRect = (rect: Rect, x: number, y: number) => {
  const cx = Math.min(Math.max(x, rect.x), rect.x + rect.width);
  const cy = Math.min(Math.max(y, rect.y), rect.y + rect.height);
  return Math.hypot(x - cx, y - cy);
};

export function resolveMoveTarget(
  split: Pick<SplitView, "orientation" | "slots">,
  panes: Readonly<Record<string, Rect>>,
  sourceTabId: string,
  start: Point,
  dx: number,
  dy: number,
): string | null {
  if (Math.hypot(dx, dy) < MOVE_HANDLE.dragSlop) return null;
  const source = panes[sourceTabId];
  if (!source) return null;
  const px = start.x + dx;
  const py = start.y + dy;
  if (contains(source, px, py)) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const threshold = Math.min(source.width * MOVE_HANDLE.intentFraction, MOVE_HANDLE.intentCap);
      if (dx >= threshold) return horizontalNeighbor(split, sourceTabId, 1);
      if (dx <= -threshold) return horizontalNeighbor(split, sourceTabId, -1);
      return null;
    }
    const threshold = Math.min(source.height * MOVE_HANDLE.intentFraction, MOVE_HANDLE.intentCap);
    if (dy >= threshold) return verticalNeighbor(split, sourceTabId, 1);
    if (dy <= -threshold) return verticalNeighbor(split, sourceTabId, -1);
    return null;
  }
  const entries = Object.entries(panes);
  const rects = entries.map(([, rect]) => rect);
  const hitX = Math.min(Math.max(px, Math.min(...rects.map((r) => r.x))), Math.max(...rects.map((r) => r.x + r.width)));
  const hitY = Math.min(Math.max(py, Math.min(...rects.map((r) => r.y))), Math.max(...rects.map((r) => r.y + r.height)));
  if (contains(source, hitX, hitY)) return null;
  for (const [id, rect] of entries) {
    if (id !== sourceTabId && contains(rect, hitX, hitY)) return id;
  }
  let bestId: string | null = null;
  let bestDist = Infinity;
  let bestTie = -Infinity;
  for (const [id, rect] of entries) {
    if (id === sourceTabId) continue;
    const dist = distanceToRect(rect, hitX, hitY);
    const tie = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? rect.x : -rect.x) : dy >= 0 ? rect.y : -rect.y;
    if (dist < bestDist - 0.5 || (Math.abs(dist - bestDist) <= 0.5 && tie > bestTie)) {
      bestId = id;
      bestDist = dist;
      bestTie = tie;
    }
  }
  return bestId;
}

export function moveHandleTooltip(leftHint: string | undefined, rightHint: string | undefined): string {
  if (leftHint && rightHint) return `Drag to move split pane (${leftHint} / ${rightHint})`;
  const one = leftHint ?? rightHint;
  return one ? `Drag to move split pane (${one})` : "Drag to move split pane";
}
