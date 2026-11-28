import { useCallback, useEffect, useRef } from "react";
import type { View } from "react-native";
import { noteToolbarRowCenter } from "../../state/windows/toolbarRow";
import { dockMoving, whenDockStill } from "../../state/windows/dockMotion";
import { useWindowSettings } from "../../state/browser/keyedWatch";
import { sidebarModeIn } from "../../state/browser/model";
import { useCurrentInterfaceScale } from "../../state/settings/interfaceScale";

export function useToolbarRowMeasure(windowId: string, on: boolean, rowCenter: number) {
  const view = useRef<View | null>(null);
  const mode = useWindowSettings(windowId, (s) => sidebarModeIn(s, windowId));
  const scale = useCurrentInterfaceScale();
  const measure = useCallback(() => {
    if (!on || dockMoving(windowId)) return;
    view.current?.measureInWindow((_x, y) => void (Number.isFinite(y) && noteToolbarRowCenter(windowId, y + rowCenter)));
  }, [windowId, on, rowCenter]);
  useEffect(() => {
    if (!on) return;
    const frame = requestAnimationFrame(measure);
    const stop = whenDockStill(windowId, measure);
    return () => {
      cancelAnimationFrame(frame);
      stop();
      noteToolbarRowCenter(windowId, null);
    };
  }, [windowId, on, measure, mode, scale]);
  return { ref: view, onLayout: measure };
}
