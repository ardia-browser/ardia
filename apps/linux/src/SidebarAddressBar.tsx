import { SidebarHeaderTools as NavigationTools } from "../../browser/src/components/sidebar/AddressBar";
import { useMenuBesideWindowButtons, useSidebarCaptionRoom } from "./sidebarHeaderLayout";
import { HEADER_TOOLS } from "../../browser/src/components/window/dockMotion";
import { ARC_LIGHTS_CENTER } from "../../browser/src/state/windows/dockMotion";
import { BROWSER_WINDOW_BUTTONS, WINDOW_CONTROLS, windowControlsWidth } from "../../browser/src/lib/windowChrome";
import { layout } from "../../browser/src/components/ui/theme";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { AppMenuButton } from "./AppMenuButton";
import { HEADER_MENU, sidebarHeaderSplit } from "./profileIndicatorLayout";

export { SidebarAddressRow } from "../../browser/src/components/sidebar/AddressBar";

const TOGGLE_ONLY = HEADER_TOOLS.fullScreenToggleX + 16;
const CONTROLS = WINDOW_CONTROLS.edge + windowControlsWidth(BROWSER_WINDOW_BUTTONS);
const SLOT = { edge: HEADER_TOOLS.edge, button: layout.toolbarButton, pitch: HEADER_TOOLS.pitch };

export function SidebarHeaderTools({ width }: { width: number }) {
  const windowId = useWindowId();
  const captionRoom = useSidebarCaptionRoom();
  const menuInHeader = !useMenuBesideWindowButtons();
  const { tools, navigation, menuLeft } = sidebarHeaderSplit({ width, captionRoom, controls: CONTROLS, toggleOnly: TOGGLE_ONLY, menuInHeader, slot: SLOT });
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
