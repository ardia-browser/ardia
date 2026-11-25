import { memo, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { devRegister } from "../dev/devRegister";
import { SwipeArea, type SwipeAreaHandle, type SwipeEvent } from "../ui";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useSettings } from "../../state/browser/hooks";
import { swipeToNeighbourTab, type TabSwipeSurface } from "../../state/tabs/tabSwipe";
import { TAB_SWIPE } from "./tokens";

const STEPPING_PHASES = new Set<SwipeEvent["phase"]>(["began", "changed", "ended"]);

export const TabSwipeArea = memo(function TabSwipeArea({ windowId, surface }: { windowId: string; surface: TabSwipeSurface }) {
  const on = useSettings((s) => s.swipeBetweenTabs) && PLATFORM_FEATURES.trackpadGestures;
  const area = useRef<SwipeAreaHandle>(null);
  const stepped = useRef(false);

  useEffect(() => {
    if (!__DEV__ || !on) return;
    const key = `${surface}:${windowId}`;
    devAreas.set(key, area);
    return () => void (devAreas.get(key) === area && devAreas.delete(key));
  }, [windowId, surface, on]);

  if (!on) return null;
  const onSwipe = (event: SwipeEvent) => {
    if (event.phase === "began") stepped.current = false;
    if (stepped.current || !STEPPING_PHASES.has(event.phase) || event.distance < TAB_SWIPE.distance) return;
    stepped.current = true;
    const tabId = swipeToNeighbourTab(windowId, event.direction === "back" ? -1 : 1, surface);
    if (__DEV__) {
      if (received.length >= 256) received.shift();
      received.push({ at: performance.now(), surface, windowId, direction: event.direction, phase: event.phase, distance: event.distance, tabId });
    }
  };
  return <SwipeArea ref={area} style={StyleSheet.absoluteFill} canSwipeBack canSwipeForward onSwipe={onSwipe} />;
});

const devAreas = new Map<string, React.RefObject<SwipeAreaHandle | null>>();
const received: object[] = [];
devRegister("acTabSwipe", "received", () => received.splice(0));
devRegister("acTabSwipe", "area", (windowId: string, surface: TabSwipeSurface = "toolbar") => devAreas.get(`${surface}:${windowId}`)?.current ?? null);
