import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { switchOn } from "../../state/app/switches";
import { ContextMenuArea, space, WindowDragRegion } from "../ui";
import { layout } from "../ui/theme";
import { TintInk } from "../ui/TintInk";
import { SidebarTextScope } from "./SidebarTextScope";
import { ThemeScope } from "../window/ThemeScope";
import { PageProfileContext, useSettings, useWindowId } from "../../state/browser/hooks";
import { newTab } from "../../state/tabs/actions";
import { sidebarListLengthNow, useSidebarCells } from "../../state/sidebar/hooks";
import { useSidebarField, useSidebarPart } from "../../state/sidebar/chrome";
import { SIDEBAR_PLAYER_GROWTH, SIDEBAR_PLAYER_HEIGHT, SidebarPlayer, usePlayerMotion, useSidebarPlayerTab } from "../media/SidebarPlayer";
import { usePageStyle } from "../../state/windows/profilePager";
import { useSharedTilesStyle } from "../../state/sidebar/sharedTiles";
import { DragPage, DragScope, useDragController, useDragging, usePinnedCount } from "./DragProvider";
import { openSidebarMenu } from "../../state/sidebar/menus";
import { noteRowsScrolled } from "../../state/sidebar/hover";
import { PinnedGrid } from "./PinnedGrid";
import { pinGridHeight } from "./pinZone";
import { SCROLL_EDGE, ScrollEdgeLine, useScrollEdge, useScrollEdgeBelow } from "./ScrollEdge";
import { listTopGap, sidebarHeaderOf, toolbarEdgeLift } from "./geometry";
import { useAddressBarInSidebar, usePageFrameInset, useToolbarLightsCenter } from "../../state/windows/layout";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { startsOffScreen } from "../../state/sidebar/geometry";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { clearlyOverflows, DOCK_SHARE, DOCKED_ROW_PAD, dockedAfter, GLOW_ROOM, pageLayout, tilesFitDock, type SidebarGeometry } from "./pageLayout";
import { noteNewTabDocked } from "../../state/telemetry/sidebarScrollCounts";
import { PageRows } from "./PageRows";
import { NewTabRow } from "./NewTabRow";
import { SelectedRowPillFrame, useListFrame, useSelectedRowAway } from "./SelectedRowPill";
import { withOverscan, type ListViewport } from "./listViewport";

const NONE: string[] = [];
type PageGeometry = { scrollY: number; viewport: number; regions: SidebarGeometry["regions"] };
const LIST_PAD = GLOW_ROOM + SCROLL_EDGE.inset;

type PageProps = {
  profileId: string;
  slot: number;
  paging: boolean;
  width: number;
  current: boolean;
  resting: boolean;
  canDock: boolean;
  height: number;
  rows: number | undefined;
  geometry: RefObject<SidebarGeometry> | undefined;
  onScrollView: (view: ScrollView | null) => void;
  onScrollY: (y: number) => void;
};

export const SidebarPage = memo(function SidebarPage({ profileId, slot, paging, width, current, resting, canDock, height, rows, geometry, onScrollView, onScrollY }: PageProps) {
  const windowId = useWindowId();
  const topGap = listTopGap(useSidebarField() === "top");
  const pinnedShown = useSidebarPart("pinned");
  const newTabShown = useSidebarPart("newTab");
  const pageStyle = usePageStyle(windowId, slot, width);
  const sharedTiles = useSharedTilesStyle(windowId, slot, width, paging);
  const [lazy] = useState(() => switchOn("lazySidebarRows"));
  const [beside, setBeside] = useState(() => startsOffScreen(lazy, current));
  useEffect(() => {
    if (!beside) return;
    const frame = requestAnimationFrame(() => setBeside(false));
    return () => cancelAnimationFrame(frame);
  }, [beside]);
  const offScreen = beside && !current;
  const playerTab = useSidebarPlayerTab(windowId, profileId, current);
  const playerHeight = playerTab ? SIDEBAR_PLAYER_HEIGHT : 0;
  const playerMotion = usePlayerMotion();
  const cells = useSidebarCells(windowId, profileId, offScreen);
  const tiles = pinnedShown ? cells : NONE;
  const innerWidth = width - layout.sidebarInset * 2;
  const dragging = useDragging() && current;
  const previewed = usePinnedCount(tiles);
  const dockRoom = height ? (height - playerHeight) * DOCK_SHARE - topGap - SCROLL_EDGE.gap - SCROLL_EDGE.line : Infinity;
  const balanced = useSettings((st) => st.balancedTopApps);
  const gridHeight = (count: number) => pinGridHeight(count, innerWidth, layout.pinnedHeight, balanced);
  const fits = tilesFitDock({ tiles: tiles.length, gridHeight, dockRoom });
  const fixedBeforeDrag = useRef(true);
  useLayoutEffect(() => {
    if (!dragging) fixedBeforeDrag.current = fits;
  });
  const [dockedNow, setDockedNow] = useState(false);
  const [dockGuessed, setDockGuessed] = useState(false);
  if (!dockGuessed && canDock && height > 0) {
    setDockGuessed(true);
    if (clearlyOverflows(sidebarListLengthNow(windowId, profileId), height)) setDockedNow(true);
  }
  const docked = canDock && dockedNow;
  const { dockFixed, capped } = pageLayout({
    tiles: tiles.length,
    previewed,
    dockRoom,
    gridHeight,
    dragging,
    fixedBeforeDrag: fixedBeforeDrag.current,
  });
  const pageDrag = useDragController();
  const liveDrag = current ? pageDrag : undefined;
  useLayoutEffect(() => {
    if (!liveDrag) return;
    liveDrag.tilesFixed = dockFixed;
    liveDrag.tilesRoom = dockRoom;
  }, [liveDrag, dockFixed, dockRoom]);
  const fixedTiles = dockFixed ? tiles : NONE;
  const scrolledTiles = dockFixed ? NONE : tiles;
  useLayoutEffect(() => {
    if (geometry) geometry.current.tilesFixed = dockFixed;
  }, [geometry, dockFixed]);
  const scrollEdge = useScrollEdge();
  const edgeLift = useToolbarEdgeLift(fixedTiles.length === 0 && topGap === listTopGap(false));
  useLayoutEffect(() => {
    if (geometry) geometry.current.edgeLift = edgeLift;
  }, [geometry, edgeLift]);
  const scrollEdgeBelow = useScrollEdgeBelow();
  const scrollY = useRef(new Animated.Value(0)).current;
  const isCurrent = useRef(current);
  isCurrent.current = current;
  const windowRef = useRef(windowId);
  windowRef.current = windowId;
  const page = useRef<PageGeometry>({ scrollY: 0, viewport: 0, regions: { pinnedGroups: 0, list: 0 } }).current;
  const scrollView = useRef<ScrollView | null>(null);
  const [listViewport] = useState<ListViewport>(() => ({
    band: () => (page.viewport ? withOverscan(page.scrollY - LIST_PAD - page.regions.list, page.viewport) : null),
  }));
  useLayoutEffect(() => {
    if (!current) return;
    onScrollView(scrollView.current);
    return () => onScrollView(null);
  }, [current, onScrollView]);
  const selectedRow = useSelectedRowAway(windowId, geometry, scrollView, () => page.scrollY);
  const listFrame = useListFrame();
  useLayoutEffect(() => {
    if (!geometry) return;
    geometry.current.viewport = page.viewport;
    geometry.current.regions = page.regions;
    onScrollY(page.scrollY);
  }, [geometry]);
  const [onScroll] = useState(() =>
    Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
      listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        page.scrollY = e.nativeEvent.contentOffset.y;
        scrollEdge.follow(page.scrollY);
        scrollEdgeBelow.measure({ offset: page.scrollY });
        selectedRow.judge();
        if (!isCurrent.current) return;
        noteRowsScrolled(windowRef.current);
        onScrollY(page.scrollY);
      },
    }),
  );
  const edge = useMemo(() => scrollY.interpolate({ inputRange: [0, 1], outputRange: [0, GLOW_ROOM - edgeLift], extrapolate: "clamp" }), [scrollY, edgeLift]);
  const unedge = useMemo(() => Animated.multiply(edge, -1), [edge]);
  const onSlack = (e: LayoutChangeEvent) => {
    if (resting || !canDock || height <= 0) return;
    const filler = e.nativeEvent.layout.height;
    const next = dockedAfter(docked, filler, playerTab && playerMotion.expandedSlot.current ? SIDEBAR_PLAYER_GROWTH : 0);
    if (next === docked) return;
    setDockedNow(next);
    if (current) noteNewTabDocked(next);
  };
  const inlineNewTab = !docked && newTabShown;

  return (
    <Animated.View
      pointerEvents={current ? "auto" : "none"}
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, width, display: resting ? "none" : "flex", ...pageStyle }}
    >
      <PageProfileContext.Provider value={profileId}>
        <ThemeScope page>
          <TintInk>
            <SidebarTextScope>
            <DragPage live={current}>
              <View style={{ paddingTop: GLOW_ROOM, zIndex: fixedTiles.length ? 1 : 0 }}>
                <Animated.View style={[{ paddingHorizontal: layout.sidebarInset }, capped ? { maxHeight: topGap + dockRoom, overflow: "hidden" } : null, dockFixed ? sharedTiles : null]}>
                  {dockFixed ? (
                    <DragScope enabled={current}>
                      <PinnedGrid tabs={fixedTiles} innerWidth={innerWidth} />
                    </DragScope>
                  ) : null}
                </Animated.View>
                <View style={{ height: fixedTiles.length ? SCROLL_EDGE.gap : topGap - SCROLL_EDGE.inset - SCROLL_EDGE.line }} />
                <ScrollEdgeLine opacity={scrollEdge.opacity} style={edgeLift ? { marginTop: -edgeLift } : undefined} />
                {edgeLift ? <View style={{ height: edgeLift }} /> : null}
              </View>
              <Animated.View
                onLayout={listFrame.onLayout}
                style={{ flex: 1, marginTop: -GLOW_ROOM, overflow: "hidden", transform: [{ translateY: edge }] }}
              >
                <Animated.View style={{ flex: 1, transform: [{ translateY: unedge }] }}>
                  <Animated.View style={{ flex: 1, overflow: "hidden", transform: [{ translateY: playerMotion.listClip }] }}>
                    <Animated.View style={{ flex: 1, transform: [{ translateY: playerMotion.listUnclip }] }}>
                      <Animated.ScrollView
                        ref={scrollView}
                        onLayout={(e) => {
                          page.viewport = e.nativeEvent.layout.height;
                          scrollEdgeBelow.measure({ viewport: page.viewport });
                          selectedRow.relocate();
                          if (!geometry) return;
                          geometry.current.viewport = page.viewport;
                          geometry.current.laidOut?.();
                        }}
                        style={{ flex: 1 }}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={onScroll}
                        onContentSizeChange={(_, content) => {
                          scrollEdgeBelow.measure({ content });
                          selectedRow.relocate();
                        }}
                        contentContainerStyle={{ flexGrow: 1, width, paddingHorizontal: layout.sidebarInset, paddingTop: LIST_PAD, paddingBottom: docked ? GLOW_ROOM : 0 }}
                      >
                        <PageRows
                          windowId={windowId}
                          profileId={profileId}
                          current={current}
                          rows={rows}
                          lazy={lazy}
                          offScreen={offScreen}
                          tiles={scrolledTiles}
                          underDockedTiles={fixedTiles.length > 0}
                          innerWidth={innerWidth}
                          inlineNewTab={inlineNewTab}
                          controller={liveDrag}
                          geometry={geometry}
                          regions={page.regions}
                          viewport={listViewport}
                        />
                        <View key={`${docked ? "docked" : "inline"}${canDock ? "" : ":fixed"}${resting ? ":resting" : ""}`} onLayout={onSlack} style={{ flexGrow: 1, minHeight: !canDock && inlineNewTab ? 24 : 0 }}>
                          <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void openSidebarMenu(windowId)}>
                            <WindowDragRegion style={{ flex: 1 }} titleBarDoubleClick={false} onRegionDoubleClick={() => toggleNewTabBar(windowId) || newTab(windowId, { newTabCommand: true })} />
                          </ContextMenuArea>
                        </View>
                      </Animated.ScrollView>
                    </Animated.View>
                  </Animated.View>
                </Animated.View>
              </Animated.View>
              <Animated.View pointerEvents="none" style={{ height: 0, zIndex: 1, transform: [{ translateY: playerMotion.listClip }] }}>
                <ScrollEdgeLine opacity={scrollEdgeBelow.opacity} style={{ position: "absolute", left: 0, right: 0, bottom: 0 }} />
              </Animated.View>
              {geometry ? <SelectedRowPillFrame frame={listFrame} lift={edgeLift} windowId={windowId} away={selectedRow.away} bottomShift={playerMotion.listClip} /> : null}
              {playerTab ? (
                <View style={{ paddingHorizontal: layout.sidebarInset, paddingTop: docked ? space.m : 0, paddingBottom: docked ? 0 : space.m }}>
                  <SidebarPlayer tabId={playerTab} motion={playerMotion} docked={docked} />
                </View>
              ) : null}
              {docked && newTabShown ? (
                <View style={{ paddingHorizontal: layout.sidebarInset, paddingVertical: DOCKED_ROW_PAD }}>
                  <NewTabRow windowId={windowId} />
                </View>
              ) : null}
            </DragPage>
            </SidebarTextScope>
          </TintInk>
        </ThemeScope>
      </PageProfileContext.Provider>
    </Animated.View>
  );
});

function useToolbarEdgeLift(besideToolbar: boolean): number {
  const addressInSidebar = useAddressBarInSidebar();
  const lightsY = useToolbarLightsCenter()[1];
  const frame = usePageFrameInset();
  const row = useToolbarRow();
  return besideToolbar && !addressInSidebar ? toolbarEdgeLift(sidebarHeaderOf(false, lightsY), frame, row) : 0;
}
