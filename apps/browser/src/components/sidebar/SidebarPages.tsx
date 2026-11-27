import { memo, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { StyleSheet, View, type ScrollView } from "react-native";
import { pagerFor, useSettledProfile, type PagerPage } from "../../state/windows/profilePager";
import { GLOW_ROOM, rowPitch, type PageSpot, type SidebarGeometry } from "./pageLayout";
import { SidebarPage } from "./SidebarPage";

export type SidebarPagesProps = {
  windowId: string;
  pages: PagerPage[];
  paging: boolean;
  width: number;
  current: string;
  dragging: boolean;
  canDock: boolean;
  available: number;
  topField: boolean;
  geometry: RefObject<SidebarGeometry>;
  onScrollView: (view: ScrollView | null) => void;
  onScrollY: (y: number) => void;
};

export const SidebarPages = memo(function SidebarPages({ windowId, pages, paging, width, current, dragging, canDock, available, topField, geometry, onScrollView, onScrollY }: SidebarPagesProps) {
  const settled = useSettledProfile(windowId, current);
  const [spots] = useState(() => new Map<string, PageSpot>());
  const claimed = useRef<PageSpot | null>(null);
  const pager = pagerFor(windowId);
  const waiting = settled !== current;
  useLayoutEffect(() => {
    if (dragging && waiting) pager.bypassHold();
  }, [dragging, waiting, pager]);
  const shown = dragging || !pages.some((page) => page.id === settled) ? current : settled;
  const capRows = Math.ceil(available / rowPitch()) + 1;
  useLayoutEffect(() => {
    const spot = spots.get(current) ?? null;
    if (spot === claimed.current) return;
    if (claimed.current) claimed.current.owns = false;
    claimed.current = spot;
    if (!spot) {
      onScrollView(null);
      return;
    }
    spot.owns = true;
    Object.assign(geometry.current, { viewport: spot.viewport, regions: spot.regions, tilesFixed: spot.tilesFixed, newTabAtTop: spot.newTabAtTop, edgeLift: spot.edgeLift, ownerShown: () => spot.shown });
    onScrollView(spot.scroller);
    onScrollY(spot.scrollY);
    geometry.current.laidOut?.();
  });
  return (
    <View pointerEvents={shown === current ? "box-none" : "none"} style={StyleSheet.absoluteFill}>
      {pages.map((page) => (
        <SidebarPage
          key={page.id}
          profileId={page.id}
          slot={page.slot}
          paging={paging}
          width={width}
          current={page.id === shown}
          resting={!!page.resting}
          canDock={canDock}
          height={Math.max(0, available - (topField ? GLOW_ROOM : 0))}
          rows={page.id === shown ? undefined : capRows}
          geometry={page.id === shown ? geometry : undefined}
          sharedGeometry={geometry}
          spots={spots}
          onScrollView={onScrollView}
          onScrollY={onScrollY}
        />
      ))}
    </View>
  );
});
