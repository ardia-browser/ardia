import type { SplitSide } from "../../state/splits/splits";
import type { Rect } from "../window/geometry";

export const DROP_SIDES: readonly SplitSide[] = ["left", "right", "top", "bottom"];

const STAGES = {
  rest: { depth: 0.12, span: 0.36, inset: 0.025 },
  grown: { depth: 0.19, span: 0.52, inset: 0.02 },
  active: { depth: 0.22, span: 0.58, inset: 0.02 },
} as const;
export type ZoneStage = keyof typeof STAGES;
const LEAN = 0.43;

const PREVIEW = { width: 209, height: 110 };

export const isHorizontalSide = (side: SplitSide) => side === "left" || side === "right";

export function zoneRect(pane: Rect, side: SplitSide, stage: ZoneStage, pointerX = 0, pointerY = 0): Rect {
  const s = STAGES[stage];
  if (isHorizontalSide(side)) {
    const width = pane.width * s.depth;
    const height = pane.height * s.span;
    const inset = pane.width * s.inset;
    const y = pane.y + (pane.height - height) / 2;
    if (stage !== "active") return { x: side === "left" ? pane.x + inset : pane.x + pane.width - inset - width, y, width, height };
    const home = zoneRect(pane, side, "grown");
    const centre = home.x + home.width / 2;
    const lean = centre + (pointerX - centre) * LEAN;
    const x = Math.max(pane.x + inset, Math.min(pane.x + pane.width - inset - width, lean - width / 2));
    return { x, y, width, height };
  }
  const width = pane.width * s.span;
  const height = pane.height * s.depth;
  const inset = pane.height * s.inset;
  const x = pane.x + (pane.width - width) / 2;
  if (stage !== "active") return { x, y: side === "top" ? pane.y + inset : pane.y + pane.height - inset - height, width, height };
  const home = zoneRect(pane, side, "grown");
  const centre = home.y + home.height / 2;
  const lean = centre + (pointerY - centre) * LEAN;
  const y = Math.max(pane.y + inset, Math.min(pane.y + pane.height - inset - height, lean - height / 2));
  return { x, y, width, height };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const contains = (r: Rect, px: number, py: number) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;

function edgeDistance(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return Math.hypot(dx, dy);
}

export function zoneHit(panes: [string, Rect][], px: number, py: number, current: { tabId: string; side: SplitSide } | null) {
  const card = { x: px - PREVIEW.width / 2, y: py - PREVIEW.height / 2, width: PREVIEW.width, height: PREVIEW.height };
  let best: { tabId: string; side: SplitSide; rank: number; edge: number; centre: number } | null = null;
  for (const [tabId, pane] of panes) {
    const inPane = contains(pane, px, py);
    for (const side of DROP_SIDES) {
      const keep = current?.tabId === tabId && current.side === side;
      const r = zoneRect(pane, side, keep ? "active" : "grown", px, py);
      if (!overlaps(card, r)) continue;
      const edge = edgeDistance(px, py, r);
      const rank = edge === 0 ? (keep ? 0 : 1) : keep ? 2 : inPane ? 3 : 4;
      const centre = isHorizontalSide(side) ? Math.abs(r.x + r.width / 2 - px) : Math.abs(r.y + r.height / 2 - py);
      if (!best || rank < best.rank || (rank === best.rank && (edge < best.edge || (edge === best.edge && centre < best.centre)))) {
        best = { tabId, side, rank, edge, centre };
      }
    }
  }
  return best && { tabId: best.tabId, side: best.side };
}
