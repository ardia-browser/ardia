import { View } from "react-native";
import { currentSettings } from "../../state/browser/current";
import { useSidebarSide } from "../../state/browser/hooks";
import { updateSettings } from "../../state/settings/actions";
import { resetSidebarWidth } from "../../state/sidebar/actions";
import { useResizeDrag } from "./useResizeDrag";
import { setLiveSidebarWidth } from "../../state/sidebar/sidebarUi";
import { noteSidebarResize } from "../../state/telemetry/sidebarResizeCounts";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RESIZE_HANDLE } from "./tokens";

const HALF = SIDEBAR_RESIZE_HANDLE.width / 2;

export function ResizeHandle({ windowId }: { windowId: string }) {
  const right = useSidebarSide(windowId) === "right";
  const handlers = useResizeDrag({
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    direction: right ? -1 : 1,
    saved: () => currentSettings().sidebarWidth,
    pointerFromEdge: (e) => e.nativeEvent.locationX - HALF,
    onLive: (w) => setLiveSidebarWidth(windowId, w),
    onCommit: (w, dragged) => {
      if (dragged) noteSidebarResize();
      updateSettings({ sidebarWidth: w });
    },
  });
  return (
    <View
      {...handlers}
      onDoubleClick={resetSidebarWidth}
      style={{ position: "absolute", top: SIDEBAR_RESIZE_HANDLE.top, bottom: 0, [right ? "left" : "right"]: -HALF, width: SIDEBAR_RESIZE_HANDLE.width, cursor: "col-resize" }}
    />
  );
}
