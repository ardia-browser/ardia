import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { switchOn } from "../../state/app/switches";
import { ContextMenuArea, space, WindowDragRegion } from "../ui";
import { layout } from "../ui/theme";
import { SidebarInk } from "./SidebarTextScope";
import { ThemeScope } from "../window/ThemeScope";
import { PageProfileContext, useSettings, useWindowFullScreen, useWindowId } from "../../state/browser/hooks";
import { newTab } from "../../state/tabs/actions";
import { sidebarListLengthNow, useSidebarCells } from "../../state/sidebar/hooks";
import { useNewTabAtTop, useSidebarField, useSidebarPart } from "../../state/sidebar/chrome";
import { SIDEBAR_PLAYER_GROWTH, SIDEBAR_PLAYER_HEIGHT, SidebarPlayer, useSidebarPlayerTab } from "../media/SidebarPlayer";
import { usePlayerMotion } from "../media/playerMotion";
import { usePageStyle } from "../../state/windows/profilePager";
import { notePlayerTop, useSharedTilesStyle, useStationaryPlayerStyle } from "../../state/sidebar/sharedTiles";
import { DragScope, useDragPage, useDragController, useDragging, usePinnedCount } from "./DragProvider";
import { openSidebarMenu } from "../../state/sidebar/menus";
import { forgetRowsScrolled, noteRowsScrolled } from "../../state/sidebar/hover";
import { PinnedGrid } from "./PinnedGrid";
import { pinGridHeight } from "./pinZone";
import { SCROLL_EDGE, ScrollEdgeLine, useScrollEdge, useScrollEdgeBelow } from "./ScrollEdge";
import { listTopGap, sidebarHeaderOf, toolbarEdgeLift } from "./geometry";
import { collapsedSidebarHeader, useAddressBarInSidebar, usePageFrameInset, useSidebarHeaderCollapsed, useToolbarLightsCenter } from "../../state/windows/layout";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { startsOffScreen } from "../../state/sidebar/geometry";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { clearlyOverflows, DOCK_SHARE, DOCKED_ROW_PAD, dockedAfter, GLOW_ROOM, pageLayout, tilesFitDock, type PageSpot, type SidebarGeometry } from "./pageLayout";
import { noteNewTabDocked } from "../../state/telemetry/sidebarScrollCounts";
import { noteSidebarPlayerStayedAcrossPages } from "../../state/telemetry/mediaCardCounts";
import { PageRows } from "./PageRows";
import { NewTabRow } from "./NewTabRow";
import { SelectedRowPill, useSelectedRowAway } from "./SelectedRowPill";
import { withOverscan, type ListViewport } from "./listViewport";

const NONE: string[] = [];
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
  sharedGeometry: RefObject<SidebarGeometry>;
  spots: Map<string, PageSpot>;
  onScrollView: (view: ScrollView | null) => void;
  onScrollY: (y: number) => void;
};

export const SidebarPage = memo(function SidebarPage({ profileId, slot, paging, width, current, resting, canDock, height, rows, geometry, sharedGeometry, spots, onScrollView, onScrollY }: PageProps) {
  const windowId = useWindowId();
  const dragPage = useDragPage(current);
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
  const playerAcrossProfiles = useSettings((st) => st.playingNowAcrossProfiles);
  const sharedPlayer = paging && playerAcrossProfiles;
  const playerMotion = usePlayerMotion(sharedPlayer ? windowId : null);
  const stationaryPlayer = useStationaryPlayerStyle(windowId, slot, width, paging && playerAcrossProfiles && !!playerTab);
  const wasCurrent = useRef(current);
  useEffect(() => {
    if (current && !wasCurrent.current && stationaryPlayer) noteSidebarPlayerStayedAcrossPages();
    wasCurrent.current = current;
  }, [current, stationaryPlayer]);
  useEffect(() => {
    if (!playerTab) notePlayerTop(windowId, profileId, null);
  }, [windowId, profileId, playerTab]);
  useEffect(() => () => notePlayerTop(windowId, profileId, null), [windowId, profileId]);
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
  const scrollEdge = useScrollEdge();
  const edgeGap = fixedTiles.length ? SCROLL_EDGE.gap : topGap - SCROLL_EDGE.inset - SCROLL_EDGE.line;
  const edgeLift = useToolbarEdgeLift(fixedTiles.length === 0 && topGap === listTopGap(false));
  const scrollEdgeBelow = useScrollEdgeBelow();
  const scrollY = useRef(new Animated.Value(0)).current;
  const windowRef = useRef(windowId);
  windowRef.current = windowId;
  useEffect(() => () => forgetRowsScrolled(windowRef.current), []);
  const page = useRef<PageSpot>({ scrollY: 0, viewport: 0, regions: { pinnedGroups: 0, list: 0 }, tilesFixed: true, newTabAtTop: false, edgeLift: 0, shown: false, owns: false, scroller: null }).current;
  const scrollView = useRef<ScrollView | null>(null);
  useLayoutEffect(() => {
    page.scroller = scrollView.current;
    spots.set(profileId, page);
    return () => {
      if (spots.get(profileId) === page) spots.delete(profileId);
      if (page.owns) onScrollView(null);
      page.owns = false;
    };
  }, [spots, profileId, page, onScrollView]);
  const [listViewport] = useState<ListViewport>(() => ({
    band: () => (page.viewport ? withOverscan(page.scrollY - LIST_PAD - page.regions.list, page.viewport) : null),
  }));
  const selectedRow = useSelectedRowAway(windowId, geometry, scrollView, () => page.scrollY, profileId);
  const [onScroll] = useState(() =>
    Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
      listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        page.scrollY = e.nativeEvent.contentOffset.y;
        scrollEdge.follow(page.scrollY);
        scrollEdgeBelow.measure({ offset: page.scrollY });
        selectedRow.judge();
        if (!page.owns) return;
        noteRowsScrolled(windowRef.current, profileId, page.scrollY);
        onScrollY(page.scrollY);
      },
    }),
  );
  const edge = useMemo(() => scrollY.interpolate({ inputRange: [0, 1], outputRange: [0, GLOW_ROOM - edgeLift], extrapolate: "clamp" }), [scrollY, edgeLift]);
  const unedge = useMemo(() => Animated.multiply(edge, -1), [edge]);
  const clipUnedged = useMemo(() => Animated.add(unedge, playerMotion.listClip), [unedge, playerMotion.listClip]);
  const slack = useRef<number | null>(null);
  const applySlack = () => {
    if (resting || !canDock || height <= 0 || slack.current === null) return;
    const next = dockedAfter(docked, slack.current, playerTab && playerMotion.expandedSlot.current ? SIDEBAR_PLAYER_GROWTH : 0);
    if (next === docked) return;
    setDockedNow(next);
    if (current) noteNewTabDocked(next);
  };
  const onSlack = (e: LayoutChangeEvent) => {
    slack.current = e.nativeEvent.layout.height;
    applySlack();
  };
  useEffect(applySlack, [height > 0, canDock, resting]);
  const inlineNewTab = !docked && newTabShown;
  const newTabAtTop = useNewTabAtTop() && inlineNewTab;
  useLayoutEffect(() => {
    page.tilesFixed = dockFixed;
    page.edgeLift = edgeLift;
    page.newTabAtTop = newTabAtTop;
    const arrived = current && !page.shown;
    page.shown = current;
    if (arrived && page.owns) sharedGeometry.current.laidOut?.();
    if (!page.owns) return;
    sharedGeometry.current.tilesFixed = dockFixed;
    sharedGeometry.current.edgeLift = edgeLift;
    sharedGeometry.current.newTabAtTop = newTabAtTop;
  });

  return (
    <Animated.View
      pointerEvents={current ? "auto" : "none"}
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, width, display: resting ? "none" : "flex", ...pageStyle }}
    >
      <PageProfileContext.Provider value={profileId}>
        <ThemeScope page>
          <SidebarInk>
            {dragPage(
              <>
                <View style={{ paddingTop: GLOW_ROOM, paddingBottom: edgeGap + SCROLL_EDGE.line, zIndex: fixedTiles.length ? 1 : 0 }}>
                  {dockFixed ? (
                    <Animated.View style={[{ paddingHorizontal: layout.sidebarInset }, capped ? { maxHeight: topGap + dockRoom, overflow: "hidden" } : null, sharedTiles]}>
                      <DragScope enabled={current}>
                        <PinnedGrid tabs={fixedTiles} innerWidth={innerWidth} />
                      </DragScope>
                    </Animated.View>
                  ) : null}
                  <ScrollEdgeLine edge={scrollEdge} opacity={scrollEdge.opacity} style={{ position: "absolute", left: 0, right: 0, bottom: edgeLift }} />
                </View>
                <Animated.View
                  style={{ flex: 1, marginTop: -GLOW_ROOM, overflow: "hidden", transform: [{ translateY: edge }] }}
                >
                  <Animated.View style={{ flex: 1, overflow: "hidden", transform: [{ translateY: clipUnedged }] }}>
                        <Animated.ScrollView
                          ref={scrollView}
                          onLayout={(e) => {
                            page.viewport = e.nativeEvent.layout.height;
                            scrollEdgeBelow.measure({ viewport: page.viewport });
                            if (page.owns) sharedGeometry.current.viewport = page.viewport;
                            selectedRow.relocate();
                            if (page.owns) sharedGeometry.current.laidOut?.();
                          }}
                          style={{ flex: 1, transform: [{ translateY: playerMotion.listUnclip }] }}
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
                            geometry={undefined}
                            regions={page.regions}
                            viewport={listViewport}
                          />
                          <View key={`${docked ? "docked" : "inline"}${canDock ? "" : ":fixed"}${resting ? ":resting" : ""}`} style={{ flexGrow: 1, minHeight: !canDock && inlineNewTab ? 24 : 0 }}>
                            <ContextMenuArea style={{ flex: 1 }} onLayout={onSlack} onContextMenu={() => void openSidebarMenu(windowId)}>
                              <WindowDragRegion style={{ flex: 1 }} titleBarDoubleClick={false} onRegionDoubleClick={() => toggleNewTabBar(windowId) || newTab(windowId, { newTabCommand: true })} />
                            </ContextMenuArea>
                          </View>
                        </Animated.ScrollView>
                  </Animated.View>
                  {geometry ? <SelectedRowPill windowId={windowId} tracker={selectedRow} lift={edgeLift} unedge={unedge} bottomShift={playerMotion.listClip} /> : null}
                </Animated.View>
                <ScrollEdgeLine edge={scrollEdgeBelow} opacity={scrollEdgeBelow.opacity} style={{ marginTop: -SCROLL_EDGE.line, zIndex: 1, transform: [{ translateY: playerMotion.listClip }] }} />
                {playerTab ? (
                  <Animated.View
                    onLayout={(e) => notePlayerTop(windowId, profileId, e.nativeEvent.layout.y + (docked ? space.m : 0))}
                    style={[{ paddingHorizontal: layout.sidebarInset, paddingTop: docked ? space.m : 0, paddingBottom: docked ? 0 : space.m }, stationaryPlayer]}
                  >
                    <SidebarPlayer tabId={playerTab} motion={playerMotion} docked={docked} leads={!sharedPlayer || current} />
                  </Animated.View>
                ) : null}
                {docked && newTabShown ? (
                  <View style={{ paddingHorizontal: layout.sidebarInset, paddingVertical: DOCKED_ROW_PAD }}>
                    <NewTabRow windowId={windowId} />
                  </View>
                ) : null}
              </>,
            )}
          </SidebarInk>
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
  const fullScreen = useWindowFullScreen(useWindowId());
  const collapsed = useSidebarHeaderCollapsed();
  const header = fullScreen && collapsed ? collapsedSidebarHeader(frame) : sidebarHeaderOf(false, lightsY);
  return besideToolbar && !addressInSidebar ? toolbarEdgeLift(header, frame, row) : 0;
}
