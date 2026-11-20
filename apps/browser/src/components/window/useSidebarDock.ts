import { useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { switchOn } from "../../state/app/switches";
import { useWindowId } from "../../state/browser/hooks";
import { noteSidebarSlide } from "../../state/telemetry/dockCounts";
import { peekShown, setDockMoving } from "../../state/windows/dockMotion";
import { curve } from "../ui/motion";
import { reduceMotion } from "../ui";
import { dockMove } from "./dockMotion";
import { ARC_HIDE_MS, DOCK_SLIDE } from "./tokens";

export function useSidebarDock(open: boolean, animate: boolean, arc: boolean): { dock: Animated.Value; away: boolean } {
  const windowId = useWindowId();
  const dock = useRef(new Animated.Value(open ? 1 : 0)).current;
  const was = useRef(open);
  const [away, setAway] = useState(!open);
  useEffect(() => {
    if (was.current === open) return;
    was.current = open;
    const move = dockMove({ open, animated: animate && !reduceMotion() && switchOn("sidebarSlide"), arc, peekOut: peekShown(windowId) });
    if (move === "jump") {
      dock.stopAnimation();
      dock.setValue(open ? 1 : 0);
      setDockMoving(windowId, false);
      setAway(!open);
      return;
    }
    if (open) setAway(false);
    setDockMoving(windowId, true);
    let pastTarget = false;
    const watch = dock.addListener(({ value }) => {
      if (value > 1 || value < 0) pastTarget = true;
    });
    (move === "arcHide"
      ? Animated.timing(dock, { toValue: 0, duration: ARC_HIDE_MS, easing: curve.enter, useNativeDriver: false })
      : Animated.timing(dock, { toValue: open ? 1 : 0, ...DOCK_SLIDE, useNativeDriver: false })
    ).start(({ finished }) => {
      dock.removeListener(watch);
      if (!finished) return;
      noteSidebarSlide(pastTarget);
      setDockMoving(windowId, false);
      if (!open) setAway(true);
    });
  }, [open]);
  useEffect(() => () => setDockMoving(windowId, false), []);
  return { dock, away };
}
