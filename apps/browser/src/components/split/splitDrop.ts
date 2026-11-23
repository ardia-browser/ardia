import type { SplitSide } from "../../state/splits/splits";
import type { Rect } from "../window/geometry";

const SIDE_STAGES = {
  rest: { width: 0.1324, height: 0.383, inset: 0.025 },
  grown: { width: 0.215, height: 0.611, inset: 0.02 },
  active: { width: 0.241, height: 0.69, inset: 0.02 },
} as const;

const EDGE_STAGES = {
  rest: { width: 0.4, height: 0.15, inset: 0.025 },
  grown: { width: 0.46, height: 0.2, inset: 0.02 },
  active: { width: 0.48, height: 0.22, inset: 0.02 },
} as const;

export type ZoneStage = keyof typeof SIDE_STAGES;
export const DROP_SIDES: readonly SplitSide[] = ["left", "right", "top", "bottom"];
const LEAN = 0.43;

export const PREVIEW = { width: 209, height: 110 };

export const isVerticalSplitSide = (side: SplitSide): boolean => side === "top" || side === "bottom";

export function zoneRect(pane: Rect, side: SplitSide, stage: ZoneStage, pointerX = 0, pointerY = 0): Rect {
  if (isVerticalSplitSide(side)) {
    const s = EDGE_STAGES[stage];
    const width = pane.width * s.width;
    const height = pane.height * s.height;
    const inset = pane.height * s.inset;
    const x = pane.x + (pane.width - width) / 2;
    if (stage !== "active") return { x, y: side === "top" ? pane.y + inset : pane.y + pane.height - inset - height, width, height };
    const home = zoneRect(pane, side, "grown");
    const centre = home.y + home.height / 2;
    const lean = centre + (pointerY - centre) * LEAN;
    const y = Math.max(pane.y + inset, Math.min(pane.y + pane.height - inset - height, lean - height / 2));
    return { x, y, width, height };
  }
  const s = SIDE_STAGES[stage];
  const width = pane.width * s.width;
  const height = pane.height * s.height;
  const inset = pane.width * s.inset;
  const y = pane.y + (pane.height - height) / 2;
  if (stage !== "active") return { x: side === "left" ? pane.x + inset : pane.x + pane.width - inset - width, y, width, height };
  const home = zoneRect(pane, side, "grown");
  const centre = home.x + home.width / 2;
  const lean = centre + (pointerX - centre) * LEAN;
  const x = Math.max(pane.x + inset, Math.min(pane.x + pane.width - inset - width, lean - width / 2));
  return { x, y, width, height };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
const pointToRect = (x: number, y: number, r: Rect) => Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.width)), Math.max(r.y - y, 0, y - (r.y + r.height)));

export function zoneHit(panes: [string, Rect][], px: number, py: number, current: { tabId: string; side: SplitSide } | null) {
  const card = { x: px - PREVIEW.width / 2, y: py - PREVIEW.height / 2, width: PREVIEW.width, height: PREVIEW.height };
  let best: { tabId: string; side: SplitSide; rank: number; edge: number; centre: number } | null = null;
  for (const [tabId, pane] of panes) {
    const inPane = contains(pane, px, py);
    for (const side of DROP_SIDES) {
      const keep = current?.tabId === tabId && current.side === side;
      const r = zoneRect(pane, side, keep ? "active" : "grown", px, py);
      if (!overlaps(card, r)) continue;
      const edge = pointToRect(px, py, r);
      const rank = edge === 0 ? (keep ? 0 : 1) : keep ? 2 : inPane ? 3 : 4;
      const centre = isVerticalSplitSide(side) ? Math.abs(r.y + r.height / 2 - py) : Math.abs(r.x + r.width / 2 - px);
      if (!best || rank < best.rank || (rank === best.rank && (edge < best.edge || (edge === best.edge && centre < best.centre)))) {
        best = { tabId, side, rank, edge, centre };
      }
    }
  }
  return best && { tabId: best.tabId, side: best.side };
}
