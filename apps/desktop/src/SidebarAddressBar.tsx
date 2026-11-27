import { SidebarHeaderTools as NavigationTools, useHeaderToggleX } from "../../browser/src/components/sidebar/AddressBar";
import { useSidebarCaptionRoom } from "./sidebarHeaderLayout";
import { useAppMenuInHeader } from "./appMenuPlacement";
import { HEADER_TOOLS, headerToggleRightEdge } from "../../browser/src/components/window/dockMotion";
import { ARC_LIGHTS_CENTER } from "../../browser/src/state/windows/dockMotion";
import { WINDOW_CONTROLS, windowControlsWidth } from "../../browser/src/lib/windowChrome";
import { useWindowChrome } from "../../browser/src/state/windows/windowButtons";
import { layout } from "../../browser/src/components/ui/theme";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { AppMenuButton } from "./AppMenuButton";
import { HEADER_MENU, sidebarHeaderSplit } from "./profileIndicatorLayout";

export { SidebarAddressRow } from "../../browser/src/components/sidebar/AddressBar";

const SLOT = { edge: HEADER_TOOLS.edge, button: layout.toolbarButton, pitch: HEADER_TOOLS.pitch };

export function SidebarHeaderTools({ width }: { width: number }) {
  const windowId = useWindowId();
  const controls = WINDOW_CONTROLS.edge + windowControlsWidth(useWindowChrome().trailingButtons.length);
  const toggleOnly = headerToggleRightEdge(useHeaderToggleX(windowId));
  const captionRoom = useSidebarCaptionRoom();
  const menuInHeader = useAppMenuInHeader();
  const { tools, navigation, menuLeft } = sidebarHeaderSplit({ width, captionRoom, controls, toggleOnly, menuInHeader, slot: SLOT });
  if (!tools) return null;
  return (
    <>
      <NavigationTools width={navigation + captionRoom} />
      {menuInHeader ? (
        <div style={{ position: "absolute", left: menuLeft, top: ARC_LIGHTS_CENTER[1] - HEADER_MENU.height / 2, width: HEADER_MENU.width, height: HEADER_MENU.height, display: "flex" }}>
          <AppMenuButton windowId={windowId} />
        </div>
      ) : null}
    </>
  );
}
