import type { SplitSide } from "../../state/splits/splits";
import type { DropTarget, PaneDropSide } from "../../state/drag/tabDrag";
import type { Rect } from "../window/geometry";

export const DROP_SIDES: readonly SplitSide[] = ["left", "right", "top", "bottom"];
export const PANE_SIDES: readonly PaneDropSide[] = [...DROP_SIDES, "center"];

const EDGE_BAND = { share: 0.25, min: 48, max: 180 } as const;
const HELD_SLACK = 16;
export const DROP_PREVIEW_INSET = 6;

export const isVerticalSplitSide = (side: PaneDropSide): boolean => side === "top" || side === "bottom";

const edgeBand = (length: number) => Math.min(EDGE_BAND.max, Math.max(EDGE_BAND.min, length * EDGE_BAND.share), length / 2);
const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

export function paneSideAt(pane: Rect, px: number, py: number, sides: readonly PaneDropSide[] = DROP_SIDES, held: PaneDropSide | null = null): PaneDropSide | null {
  const depth: Record<SplitSide, number> = { left: px - pane.x, right: pane.x + pane.width - px, top: py - pane.y, bottom: pane.y + pane.height - py };
  let best: { side: SplitSide; reach: number } | null = null;
  for (const side of sides) {
    if (side === "center") continue;
    const band = edgeBand(isVerticalSplitSide(side) ? pane.height : pane.width);
    const reach = (depth[side] + (held === side ? -HELD_SLACK : held === "center" ? HELD_SLACK : 0)) / band;
    if (reach <= 1 && (!best || reach < best.reach)) best = { side, reach };
  }
  if (best) return best.side;
  return sides.includes("center") ? "center" : null;
}

export function paneDropTarget(panes: [string, Rect][], px: number, py: number, current: DropTarget | null, sides: readonly PaneDropSide[] = DROP_SIDES): DropTarget | null {
  for (const [tabId, pane] of panes) {
    if (!contains(pane, px, py)) continue;
    const side = paneSideAt(pane, px, py, sides, current?.tabId === tabId ? current.side : null);
    return side && { tabId, side };
  }
  return null;
}

export function dropPreviewRect(pane: Rect, side: PaneDropSide): Rect {
  const inset = DROP_PREVIEW_INSET;
  const whole = { x: pane.x + inset, y: pane.y + inset, width: pane.width - inset * 2, height: pane.height - inset * 2 };
  if (side === "center") return whole;
  if (isVerticalSplitSide(side)) {
    const height = pane.height / 2 - inset * 1.5;
    return { ...whole, y: side === "top" ? whole.y : pane.y + pane.height - inset - height, height };
  }
  const width = pane.width / 2 - inset * 1.5;
  return { ...whole, x: side === "left" ? whole.x : pane.x + pane.width - inset - width, width };
}
