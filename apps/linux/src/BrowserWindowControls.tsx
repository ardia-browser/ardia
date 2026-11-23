import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useActiveTabId, useTabsShown, useWindow, useWindowId } from "../../browser/src/state/browser/hooks";
import { usePageFrameInset, useTabLayout, useWindowControlsCenterY, useWindowControlsHost, useWindowControlsInset, useWindowControlsLeading, useWindowControlsSize } from "../../browser/src/state/windows/layout";
import { useWindowChrome } from "../../browser/src/state/windows/windowButtons";
import { useFullscreenTab } from "../../browser/src/state/tabs/pageState";
import { STRIP_HEIGHT } from "../../browser/src/state/windows/toolbarAutoHide";
import { captionRoom, WINDOW_CHROME, WINDOW_CONTROLS } from "../../browser/src/lib/windowChrome";
import { TintInk } from "../../browser/src/components/ui/TintInk";
import { useTheme, WindowDragRegion } from "../../browser/src/components/ui";
import { useSitePalette } from "../../browser/src/components/toolbar/useSitePalette";
import { usePaneChrome } from "../../browser/src/components/toolbar/WindowToolbar";
import { controlsShown, WindowControls } from "./WindowControls";
import { LeadingWindowControls } from "./LeadingWindowControls";
import { showAppMenu } from "./clusterAppMenu";
import { PageOverlayRegion } from "./PageOverlayRegion";

const BAND_TRIGGER_HEIGHT = 6;
const BAND_UNPEEK_MS = 250;

export const browserWindowControls = () =>
  controlsShown ? (
    <>
      <PlacedControls />
      <PlacedLeadingControls />
    </>
  ) : null;

function PlacedLeadingControls() {
  const windowId = useWindowId();
  const small = useWindow(windowId, (w) => w?.kind === "small");
  return <LeadingWindowControls windowId={windowId} size={small ? WINDOW_CONTROLS.small : WINDOW_CONTROLS.regular} />;
}

function PlacedControls() {
  useWindowChrome();
  const windowId = useWindowId();
  const centerY = useWindowControlsCenterY();
  const size = useWindowControlsSize();
  const host = useWindowControlsHost();
  const leading = useWindowControlsLeading();
  const inset = useWindowControlsInset();
  const onMenu = useCallback(() => void showAppMenu(windowId), [windowId]);
  if (centerY === null || !host) return null;
  if (host === "toolbar") return <ToolbarControls windowId={windowId} centerY={centerY} size={size} onMenu={onMenu} />;
  if (host === "band") return <BandControls windowId={windowId} centerY={centerY} size={size} leading={leading} inset={inset} onMenu={onMenu} />;
  return (
    <TintInk>
      <WindowControls windowId={windowId} onMenu={onMenu} centerY={centerY} size={size} leading={leading} inset={inset} />
    </TintInk>
  );
}

function BandControls({ windowId, centerY, size, leading, inset, onMenu }: { windowId: string; centerY: number; size: number; leading: boolean; inset: number; onMenu: () => void }) {
  const theme = useTheme();
  const pageFullscreen = !!useFullscreenTab(windowId);
  const tabLayout = useTabLayout();
  const tabsShown = useTabsShown(windowId);
  const topTabsHidden = tabLayout === "top" && !tabsShown;
  const [revealed, setRevealed] = useState(false);
  const focusedRef = useRef(false);
  const hoveredRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (pageFullscreen) {
      clearTimeout(hideTimer.current);
      focusedRef.current = false;
      hoveredRef.current = false;
      setRevealed(false);
    }
  }, [pageFullscreen]);
  const show = useCallback(() => {
    clearTimeout(hideTimer.current);
    setRevealed(true);
  }, []);
  const scheduleHide = useCallback(() => {
    if (focusedRef.current || hoveredRef.current) return;
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!focusedRef.current && !hoveredRef.current) setRevealed(false);
    }, BAND_UNPEEK_MS);
  }, []);
  const onPointerEnter = useCallback(() => {
    hoveredRef.current = true;
    show();
  }, [show]);
  const onPointerLeave = useCallback(() => {
    hoveredRef.current = false;
    scheduleHide();
  }, [scheduleHide]);
  const onBandFocus = useCallback(() => {
    focusedRef.current = true;
    show();
  }, [show]);
  const onBandBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      focusedRef.current = false;
      scheduleHide();
    },
    [scheduleHide],
  );
  if (pageFullscreen) return null;
  const span = topTabsHidden ? { right: 0, width: captionRoom(0) } : { left: 0, right: 0 };
  const hasLeading = !tabsShown && !topTabsHidden && WINDOW_CHROME.leadingButtons.length > 0;
  return (
    <div style={{ display: "contents" }} onFocus={onBandFocus} onBlur={onBandBlur}>
      <PageOverlayRegion testID="ardia-band-peek-trigger" capturing={!revealed}>
        <View
          accessibilityRole="button"
          accessibilityLabel="Show window controls"
          tabIndex={0}
          onMouseEnter={onPointerEnter}
          onMouseLeave={onPointerLeave}
          style={{ position: "absolute", ...span, top: 0, height: BAND_TRIGGER_HEIGHT }}
        />
      </PageOverlayRegion>
      <PageOverlayRegion testID="ardia-band-peek" capturing={revealed}>
        {revealed ? (
          <View
            onMouseEnter={onPointerEnter}
            onMouseLeave={onPointerLeave}
            style={{ position: "absolute", ...span, top: 0, height: WINDOW_CHROME.titleBarHeight, backgroundColor: theme.windowTint[0] }}
          >
            <WindowDragRegion style={StyleSheet.absoluteFill} />
            <TintInk>
              {hasLeading ? (
                <WindowControls windowId={windowId} onMenu={onMenu} centerY={centerY} size={size} leading inset={WINDOW_CONTROLS.edge} buttons={WINDOW_CHROME.leadingButtons} />
              ) : null}
              <WindowControls windowId={windowId} onMenu={onMenu} centerY={centerY} size={size} leading={leading} inset={inset} />
            </TintInk>
          </View>
        ) : null}
      </PageOverlayRegion>
    </div>
  );
}

function ToolbarControls({ windowId, centerY, size, onMenu }: { windowId: string; centerY: number; size: number; onMenu: () => void }) {
  const activeId = useActiveTabId() ?? "";
  const palette = useSitePalette(activeId);
  const frame = usePageFrameInset();
  const pane = usePaneChrome(windowId);
  const live = pane && pane.tabId === activeId ? pane : undefined;
  const ink = useMemo(() => ({ icon: palette.icon, hover: palette.hover, pressed: palette.pressed }), [palette.icon, palette.hover, palette.pressed]);
  const fades = useMemo(
    () =>
      live && {
        row: live.fade.interpolate({ inputRange: [0, 0.2, 0.4, 0.6, 1], outputRange: [1, 0.45, 0.15, 0, 0] }),
        strip: live.fade.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] }),
      },
    [live?.fade],
  );
  const collapsed = live?.mode === "collapsed";
  return (
    <>
      <WindowControls windowId={windowId} onMenu={onMenu} centerY={centerY} size={size} ink={ink} opacity={fades ? fades.row : 1} hidden={collapsed} />
      {fades ? (
        <WindowControls windowId={windowId} onMenu={onMenu} centerY={frame + STRIP_HEIGHT / 2} size={WINDOW_CONTROLS.strip} ink={ink} opacity={fades.strip} hidden={!collapsed} />
      ) : null}
    </>
  );
}
