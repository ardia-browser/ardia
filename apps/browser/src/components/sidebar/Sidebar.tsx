import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ClipView, ContextMenuArea, space, WindowDragRegion } from "../ui";
import { layout, useTheme } from "../ui/theme";
import { useSidebarHighContrast } from "../../state/sidebar/textLook";
import { TintInk } from "../ui/TintInk";
import { useWindowId, useWindowProfileId } from "../../state/browser/hooks";
import { useHasDownloads, useNoTiles } from "../../state/sidebar/hooks";
import { collapsedSidebarHeader, useAddressBarInSidebar, useDownloadsInSidebarFooter, usePageFrameInset, useSidebarCaptionRoom, useSidebarHeaderCollapsed, useToolbarLightsCenter } from "../../state/windows/layout";
import { closeAnchoredWhenControlsRowChanges } from "../../state/sidebar/controlsRowChange";
import { DownloadsButton } from "../downloads/DownloadsButton";
import { profileIndicatorX, ProfileIndicator } from "../profiles/ProfileIndicator";
import { useWindowChrome } from "../../state/windows/windowButtons";
import { pagerFor, usePagerPages, useSettledProfile, type PagerPage } from "../../state/windows/profilePager";
import { PROFILE_DOTS_HEIGHT, ProfileDots, useProfileDotsShown } from "../profiles/ProfileDots";
import { SidebarAddressRow, SidebarHeaderTools } from "./AddressBar";
import { DragGhost } from "./DragGhost";
import { EdgeGlow } from "./EdgeGlow";
import { DragProvider } from "./DragProvider";
import type { DragController } from "./dragController";
import type { Ghost } from "./dragModel";
import { SidebarDropArea } from "./SidebarDropArea";
import { FolderPanel } from "./FolderPanel";
import { dismissHover, dismissHoverIn } from "../../state/sidebar/hover";
import { PinFieldZone, PinSlotZone } from "./PinnedGrid";
import { bottomFieldBand, SIDEBAR_FIELD, SIDEBAR_FIELD_BOTTOM, SIDEBAR_FOOTER_DOWNLOADS, sidebarHeaderOf } from "./geometry";
import { useNewTabAtTop, useSidebarField, useSidebarPart } from "../../state/sidebar/chrome";
import { closeFolderPanel } from "../../state/sidebar/tileFolderUi";
import { openSidebarMenu } from "../../state/sidebar/menus";
import { GLOW_ROOM, rowPitch, type PageSpot, type SidebarGeometry } from "./pageLayout";
import { SidebarPage } from "./SidebarPage";
import { sidebarText } from "./SidebarTextScope";
import { SidebarRowLookContext, useSidebarRowLookSource } from "./rowLook";
import { useRevealTabs } from "./useRevealTabs";

const HEADER_RIGHT = space.m;

export function Sidebar({ width }: { width: number }) {
  const windowId = useWindowId();
  const theme = useTheme();
  const strongText = useSidebarHighContrast();
  const current = useWindowProfileId();
  const { pages, paging } = usePagerPages(windowId);
  const [available, setAvailable] = useState(0);
  const newTabAtTop = useNewTabAtTop();
  const newTabShown = useSidebarPart("newTab");
  const canDock = !newTabAtTop && newTabShown;
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const geometry = useRef<SidebarGeometry>({ viewport: 0, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: true });
  const addressBar = useAddressBarInSidebar();
  const lightsY = useToolbarLightsCenter()[1];
  const field = useSidebarField();
  const captionRoom = useSidebarCaptionRoom();
  useWindowChrome();
  const indicatorX = profileIndicatorX();
  const collapsed = useSidebarHeaderCollapsed();
  const frame = usePageFrameInset();
  const header = collapsed && field !== "top" ? collapsedSidebarHeader(frame) : sidebarHeaderOf(addressBar, lightsY, field === "top");
  const downloadsShown = useSidebarPart("downloads");
  const hasDownloads = useHasDownloads(windowId) && downloadsShown;
  const profileShown = useSidebarPart("profile");
  const dotsWanted = useProfileDotsShown();
  const dots = dotsWanted && profileShown;
  const footerDownloads = useDownloadsInSidebarFooter() && hasDownloads;
  const band = dots || footerDownloads ? PROFILE_DOTS_HEIGHT : 0;
  const fieldBand = field === "bottom" ? bottomFieldBand() : 0;
  const footer = band + fieldBand;
  const pinnedShown = useSidebarPart("pinned");
  const nothingPinned = useNoTiles(windowId, current) && pinnedShown;
  const rowLook = useSidebarRowLookSource();

  const drag = useRef<DragController | null>(null);
  const onScrollView = useCallback((v: ScrollView | null) => {
    scroll.current = v;
    if (drag.current) drag.current.scroll = v;
  }, []);
  const onScrollY = useCallback((y: number) => {
    scrollY.current = y;
    if (drag.current) drag.current.scrollY = y;
    dismissHover();
    closeFolderPanel();
  }, []);

  useRevealTabs(windowId, scroll, scrollY, geometry);
  useLayoutEffect(() => dismissHoverIn(windowId), [windowId, current, paging]);
  useLayoutEffect(() => void (current && drag.current?.profileShown(current)), [current]);
  useEffect(() => closeAnchoredWhenControlsRowChanges(windowId), [windowId]);

  return (
    <DragProvider>
      {(ghost: Ghost | null, controller) => {
        drag.current = controller;
        return (
          <SidebarRowLookContext.Provider value={rowLook}>
          <SidebarDropArea
            ref={(v) => {
              controller.root = v;
            }}
            style={{ width, height: "100%" }}
          >
            <ClipView
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: header - GLOW_ROOM,
                bottom: footer,
                overflow: paging ? "hidden" : "visible",
              }}
              onLayout={(e) => setAvailable(e.nativeEvent.layout.height)}
            >
              <SidebarPages
                windowId={windowId}
                pages={pages}
                paging={paging}
                width={width}
                current={current}
                dragging={!!ghost}
                canDock={canDock}
                available={available}
                topField={field === "top"}
                geometry={geometry}
                onScrollView={onScrollView}
                onScrollY={onScrollY}
              />
            </ClipView>

            <TintInk>
              {footer ? (
                <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: footer }}>
                  <ContextMenuArea style={StyleSheet.absoluteFill} onContextMenu={() => void openSidebarMenu(windowId)} />
                  {field === "bottom" ? <SidebarAddressRow width={width} top={SIDEBAR_FIELD_BOTTOM.above} /> : null}
                  {dots ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><ProfileDots windowId={windowId} width={width} besideDownloads={footerDownloads} /></View> : null}
                  {footerDownloads ? (
                    <View style={{ position: "absolute", left: SIDEBAR_FOOTER_DOWNLOADS.left, bottom: SIDEBAR_FOOTER_DOWNLOADS.bottom }}>
                      <DownloadsButton windowId={windowId} />
                    </View>
                  ) : null}
                </View>
              ) : null}

              <View style={{ height: header }}>
                <ContextMenuArea style={StyleSheet.absoluteFill} onContextMenu={() => void openSidebarMenu(windowId)}>
                  <WindowDragRegion style={StyleSheet.absoluteFill} />
                </ContextMenuArea>
                {addressBar ? (
                  <>
                    <SidebarHeaderTools width={width} />
                    {field === "top" ? <SidebarAddressRow width={width} top={SIDEBAR_FIELD.top} /> : null}
                  </>
                ) : collapsed ? null : (
                  <View pointerEvents="box-none" style={{ height: header, flexDirection: "row", alignItems: "flex-start", paddingLeft: indicatorX, paddingRight: HEADER_RIGHT + captionRoom, paddingTop: lightsY - 17 }}>
                    <ProfileIndicator room={width - indicatorX - HEADER_RIGHT - captionRoom - (hasDownloads && !footerDownloads ? SIDEBAR_FOOTER_DOWNLOADS.size + 2 : 0)} profileShown={profileShown} />
                    <View pointerEvents="none" style={{ flex: 1 }} />
                    {hasDownloads && !footerDownloads ? <DownloadsButton windowId={windowId} /> : null}
                  </View>
                )}
              </View>
            </TintInk>

            {ghost && !ghost.landing && nothingPinned ? (
              field === "top" ? (
                <PinFieldZone top={SIDEBAR_FIELD.top} height={SIDEBAR_FIELD.height} />
              ) : (
                <PinSlotZone top={header - sidebarHeaderOf(addressBar, lightsY, false)} />
              )
            ) : null}
            {ghost ? <EdgeGlow /> : null}
            {sidebarText(
              theme,
              strongText,
              <>
              <FolderPanel windowId={windowId} />
              {ghost ? (
                <ClipView pointerEvents="none" style={GHOST_CLIP}>
                  <DragGhost ghost={ghost} />
                </ClipView>
              ) : null}
              </>,
            )}
          </SidebarDropArea>
          </SidebarRowLookContext.Provider>
        );
      }}
    </DragProvider>
  );
}

type SidebarPagesProps = {
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

const SidebarPages = memo(function SidebarPages({ windowId, pages, paging, width, current, dragging, canDock, available, topField, geometry, onScrollView, onScrollY }: SidebarPagesProps) {
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

const GHOST_CLIP = { ...StyleSheet.absoluteFillObject, overflow: "hidden" } as const;
