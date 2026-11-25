import { useCallback, useMemo } from "react";
import { useActiveTabId, useWindow, useWindowId } from "../../state/browser/hooks";
import { usePageFrameInset, useWindowControlsCenterY, useWindowControlsHost, useWindowControlsInset, useWindowControlsLeading, useWindowControlsSize } from "../../state/windows/layout";
import { useWindowChrome } from "../../state/windows/windowButtons";
import { STRIP_HEIGHT } from "../../state/windows/toolbarAutoHide";
import { showAppMenu } from "../../state/app/appMenu";
import { WINDOW_CONTROLS } from "../../lib/windowChrome";
import { TintInk } from "../ui/TintInk";
import { useSitePalette } from "../toolbar/useSitePalette";
import { usePaneChrome } from "../toolbar/WindowToolbar";
import { controlsShown, WindowControls } from "./WindowControls";
import { LeadingWindowControls } from "./LeadingWindowControls";

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
  return (
    <TintInk>
      <WindowControls windowId={windowId} onMenu={onMenu} centerY={centerY} size={size} leading={leading} inset={inset} />
    </TintInk>
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
