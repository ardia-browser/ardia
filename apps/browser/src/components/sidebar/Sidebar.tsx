import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ClipView, ContextMenuArea, space, WindowDragRegion } from "../ui";
import { layout } from "../ui/theme";
import { TintInk } from "../ui/TintInk";
import { useWindowId, useWindowProfileId } from "../../state/browser/hooks";
import { useHasDownloads, useNoTiles, useSidebarWidth } from "../../state/sidebar/hooks";
import { collapsedSidebarHeader, useAddressBarInSidebar, useDownloadsInSidebarFooter, usePageFrameInset, useSidebarCaptionRoom, useSidebarHeaderCollapsed, useToolbarLightsCenter } from "../../state/windows/layout";
import { closeAnchoredWhenControlsRowChanges } from "../../state/sidebar/controlsRowChange";
import { DownloadsButton } from "../downloads/DownloadsButton";
import { PROFILE_INDICATOR_X, ProfileIndicator } from "../profiles/ProfileIndicator";
import { usePagerPages } from "../../state/windows/profilePager";
import { PROFILE_DOTS_HEIGHT, ProfileDots, useProfileDotsShown } from "../profiles/ProfileDots";
import { SidebarAddressRow, SidebarHeaderTools } from "./AddressBar";
import { DragGhost } from "./DragGhost";
import { DragProvider } from "./DragProvider";
import type { DragController } from "./dragController";
import type { Ghost } from "./dragModel";
import { SidebarDropArea } from "./SidebarDropArea";
import { FolderPanel } from "./FolderPanel";
import { dismissHover, dismissHoverIn } from "../../state/sidebar/hover";
import { watchSidebarResize } from "../../state/sidebar/sidebarUi";
import { freezeOffscreenRows, thawRows } from "./resizeFreeze";
import { PinFieldZone, PinSlotZone } from "./PinnedGrid";
import { bottomFieldBand, SIDEBAR_FIELD, SIDEBAR_FIELD_BOTTOM, SIDEBAR_FOOTER_DOWNLOADS, sidebarHeaderOf } from "./geometry";
import { useNewTabAtTop, useSidebarField, useSidebarPart } from "../../state/sidebar/chrome";
import { closeFolderPanel } from "../../state/sidebar/tileFolderUi";
import { openSidebarMenu } from "../../state/sidebar/menus";
import { GLOW_ROOM, rowPitch, type SidebarGeometry } from "./pageLayout";
import { SidebarPage } from "./SidebarPage";
import { SidebarTextScope } from "./SidebarTextScope";
import { SidebarRowLookContext, useSidebarRowLookSource } from "./rowLook";
import { useRevealTabs } from "./useRevealTabs";

const HEADER_RIGHT = space.m;

export function Sidebar() {
  const windowId = useWindowId();
  const current = useWindowProfileId();
  const { pages, paging } = usePagerPages(windowId);
  const [available, setAvailable] = useState(0);
  const newTabAtTop = useNewTabAtTop();
  const newTabShown = useSidebarPart("newTab");
  const dockAbove = newTabAtTop || !newTabShown || available <= 0 ? Infinity : available - rowPitch() - 12;
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const geometry = useRef<SidebarGeometry>({ viewport: 0, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: true });
  const addressBar = useAddressBarInSidebar();
  const lightsY = useToolbarLightsCenter()[1];
  const field = useSidebarField();
  const captionRoom = useSidebarCaptionRoom();
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
    if (drag.current) {
      if (drag.current.scrollY !== y) thawRows(drag.current);
      drag.current.scrollY = y;
    }
    dismissHover();
    closeFolderPanel();
  }, []);

  useRevealTabs(windowId, scroll, scrollY, geometry);
  useEffect(
    () =>
      watchSidebarResize(windowId, (resizing) => {
        if (!drag.current) return;
        if (resizing) void freezeOffscreenRows(drag.current);
        else thawRows(drag.current);
      }),
    [windowId],
  );
  useLayoutEffect(() => dismissHoverIn(windowId), [windowId, current, paging]);
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
            style={{ width: "100%", height: "100%" }}
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
              {pages.map((page) => (
                  <SidebarPage
                    key={page.id}
                    profileId={page.id}
                    slot={page.slot}
                    paging={paging}
                    current={page.id === current}
                    resting={!!page.resting}
                    dockAbove={dockAbove}
                    height={Math.max(0, available - (field === "top" ? GLOW_ROOM : 0))}
                    rows={page.id === current ? undefined : Math.ceil(available / rowPitch()) + 1}
                    geometry={page.id === current ? geometry : undefined}
                    onScrollView={onScrollView}
                    onScrollY={onScrollY}
                  />
                ))}
            </ClipView>

            <TintInk>
              {footer ? (
                <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: footer }}>
                  <ContextMenuArea style={StyleSheet.absoluteFill} onContextMenu={() => void openSidebarMenu(windowId)} />
                  {field === "bottom" ? <SidebarAddressRow top={SIDEBAR_FIELD_BOTTOM.above} /> : null}
                  {dots ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><ProfileDots windowId={windowId} besideDownloads={footerDownloads} /></View> : null}
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
                    <SidebarHeaderTools />
                    {field === "top" ? <SidebarAddressRow top={SIDEBAR_FIELD.top} /> : null}
                  </>
                ) : collapsed ? null : (
                  <View pointerEvents="box-none" style={{ height: header, flexDirection: "row", alignItems: "flex-start", paddingLeft: PROFILE_INDICATOR_X, paddingRight: HEADER_RIGHT + captionRoom, paddingTop: lightsY - 17 }}>
                    {profileShown ? <HeaderProfile windowId={windowId} besideDownloads={hasDownloads && !footerDownloads} captionRoom={captionRoom} /> : null}
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
            <SidebarTextScope>
              <FolderPanel windowId={windowId} />
              {ghost ? <DragGhost ghost={ghost} /> : null}
            </SidebarTextScope>
          </SidebarDropArea>
          </SidebarRowLookContext.Provider>
        );
      }}
    </DragProvider>
  );
}

function HeaderProfile({ windowId, besideDownloads, captionRoom }: { windowId: string; besideDownloads: boolean; captionRoom: number }) {
  const width = useSidebarWidth(windowId);
  return <ProfileIndicator room={width - PROFILE_INDICATOR_X - HEADER_RIGHT - captionRoom - (besideDownloads ? SIDEBAR_FOOTER_DOWNLOADS.size + 2 : 0)} />;
}
