import { SidebarHeaderTools as NavigationTools } from "../../browser/src/components/sidebar/AddressBar";
import { useMenuBesideWindowButtons, useSidebarCaptionRoom } from "./sidebarHeaderLayout";
import { HEADER_TOOLS } from "../../browser/src/components/window/dockMotion";
import { BROWSER_WINDOW_BUTTONS, WINDOW_CONTROLS, windowControlsWidth } from "../../browser/src/lib/windowChrome";
import { ProfileIndicator, useProfileIndicatorWidth } from "./ProfileIndicator";
import { INDICATOR_GAP, sidebarHeaderSplit } from "./profileIndicatorLayout";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { useSidebarWidth } from "../../browser/src/state/sidebar/hooks";

export { SidebarAddressRow } from "../../browser/src/components/sidebar/AddressBar";

const TOGGLE_ONLY = HEADER_TOOLS.fullScreenToggleX + 16;
const CONTROLS = WINDOW_CONTROLS.edge + windowControlsWidth(BROWSER_WINDOW_BUTTONS);

export function SidebarHeaderTools() {
  const width = useSidebarWidth(useWindowId());
  const captionRoom = useSidebarCaptionRoom();
  const indicator = useProfileIndicatorWidth(Math.max(0, width - captionRoom - TOGGLE_ONLY - INDICATOR_GAP));
  const menuInHeader = !useMenuBesideWindowButtons();
  const { tools, navigation, indicatorRoom } = sidebarHeaderSplit({ width, captionRoom, controls: CONTROLS, indicator, toggleOnly: TOGGLE_ONLY, menuInHeader });
  if (!tools) return null;
  return (
    <>
      <NavigationTools width={navigation + captionRoom} />
      <div style={{ position: "absolute", left: navigation + 2, top: 7 }}>
        <ProfileIndicator room={indicatorRoom} />
      </div>
    </>
  );
}
