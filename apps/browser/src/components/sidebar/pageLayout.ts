import { layout } from "../ui/theme";
import type { Section } from "../../state/sidebar/geometry";

export const GLOW_ROOM = 24;
export const rowPitch = () => layout.rowHeight + layout.rowGap;
export const DOCKED_ROW_PAD = 6;
export const ROWS_PER_FRAME = 32;
export const DOCK_SHARE = 0.4;
export const DOCK_SLACK = 12;

export type SidebarGeometry = { viewport: number; regions: Record<Section, number>; newTabAtTop: boolean; tilesFixed: boolean; edgeLift?: number; laidOut?: () => void };

export type PageLayoutInput = {
  tiles: number;
  previewed: number;
  dockRoom: number;
  gridHeight: (count: number) => number;
  dragging: boolean;
  fixedBeforeDrag: boolean;
};

export type PageLayout = { dockFixed: boolean; capped: boolean };

export const tilesFitDock = ({ tiles, gridHeight, dockRoom }: Pick<PageLayoutInput, "tiles" | "gridHeight" | "dockRoom">) => !tiles || gridHeight(tiles) <= dockRoom;

export function pageLayout(i: PageLayoutInput): PageLayout {
  const dockFixed = i.dragging ? i.fixedBeforeDrag : tilesFitDock(i);
  return {
    dockFixed,
    capped: dockFixed && i.dragging && i.gridHeight(i.previewed) > i.dockRoom,
  };
}

export function dockedAfter(docked: boolean, filler: number, hiddenGrowth = 0): boolean {
  if (hiddenGrowth && filler < 1) return docked;
  const slack = filler + hiddenGrowth;
  return docked ? slack < 1 : slack < DOCK_SLACK;
}
