import type { ScrollView, View } from "react-native";
import { revealSpot } from "../../state/sidebar/geometry";
import { measureRow } from "../../state/sidebar/sidebarUi";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { SCROLL_EDGE } from "./ScrollEdge";

export type RowSpot = { y: number; height: number };
type RowAway = "above" | "below" | null;

export function visibleSpan(scrollY: number, viewport: number, edgeLift = 0): { top: number; bottom: number } {
  return { top: scrollY + (scrollY > 0 ? GLOW_ROOM - edgeLift : 0), bottom: scrollY + viewport };
}

export function rowAway(row: RowSpot | null, scrollY: number, viewport: number, edgeLift = 0): RowAway {
  if (!row || viewport <= 0) return null;
  const { top, bottom } = visibleSpan(scrollY, viewport, edgeLift);
  if (row.y + row.height <= top) return "above";
  if (row.y >= bottom) return "below";
  return null;
}

export function locateTab(
  windowId: string,
  tabId: string,
  geometry: SidebarGeometry,
  scroll: ScrollView | null,
  scrollY: () => number,
): RowSpot | Promise<RowSpot | null> | null {
  const spot = revealSpot(windowId, tabId, geometry.tilesFixed, geometry.newTabAtTop);
  if (!spot) return null;
  if ("span" in spot) return { y: GLOW_ROOM + SCROLL_EDGE.inset + geometry.regions[spot.span.section] + spot.span.top, height: spot.span.height };
  if (!scroll) return null;
  const view = scroll as unknown as View;
  const keys = spot.keys;
  const firstShown = (i: number): Promise<Awaited<ReturnType<typeof measureRow>>> =>
    i >= keys.length ? Promise.resolve(null) : measureRow(windowId, keys[i]!).then((row) => row ?? firstShown(i + 1));
  return firstShown(0).then(
    (row) => row && new Promise<RowSpot>((resolve) => view.measureInWindow((_x, y) => resolve({ y: row.y - y + scrollY(), height: row.height }))),
  );
}
