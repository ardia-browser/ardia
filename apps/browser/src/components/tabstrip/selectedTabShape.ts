import { snappedToGrid } from "../../lib/interfaceScale";
import { FLARE, SELECTED_BODY_INSET } from "./tokens";

export type SelectedTabShape = { inset: number; flare: number; body: number };

export const selectedTabEdges = (pixelsPerPoint: number): Pick<SelectedTabShape, "inset" | "flare"> => ({
  inset: snappedToGrid(SELECTED_BODY_INSET, pixelsPerPoint),
  flare: snappedToGrid(FLARE, pixelsPerPoint),
});

export function selectedTabShape(width: number, pixelsPerPoint: number): SelectedTabShape {
  const edges = selectedTabEdges(pixelsPerPoint);
  return { ...edges, body: snappedToGrid(width - 2 * edges.inset, pixelsPerPoint) };
}
