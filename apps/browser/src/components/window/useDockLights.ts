import { useEffect, useRef } from "react";
import type { Animated } from "react-native";
import { setTrafficLightsCenter } from "../../state/windows/nativeWindow";
import { dockMoving, sidebarLightsCenter, stillOffWindow, TOP_STRIP_LIGHTS_CENTER } from "../../state/windows/dockMotion";
import { currentValue } from "../ui/motion";
import { noteSidebarLightsLeftBehind } from "../../state/telemetry/dockCounts";

export function useTopStripLights(windowId: string, dock: Animated.Value, on: boolean, travel: number, open: boolean) {
  useEffect(() => {
    if (!on) return;
    const place = (value: number) => {
      if (!dockMoving(windowId)) return;
      const up = Math.round(travel * (1 - value) * 2) / 2;
      void setTrafficLightsCenter(windowId, [TOP_STRIP_LIGHTS_CENTER[0], TOP_STRIP_LIGHTS_CENTER[1] - up]);
    };
    place(currentValue(dock));
    const sub = dock.addListener(({ value }) => place(value));
    return () => dock.removeListener(sub);
  }, [windowId, dock, on, travel, open]);
}

export type SidebarLights = { width: number; moving: boolean; peeking: boolean; fullscreen: boolean; lights: readonly [number, number]; right: boolean; peekAt: { left: number; top: number } };

export function useSidebarLights(windowId: string, dock: Animated.Value, slide: Animated.Value, o: SidebarLights, onSlide: (value: number) => void = () => {}) {
  const latestOnSlide = useRef(onSlide);
  latestOnSlide.current = onSlide;
  const values = useRef({ dock: 1, slide: 0 });
  const apply = useRef<() => void>(() => {});
  const sent = useRef<ReturnType<typeof slidingCenter> | undefined>(undefined);
  apply.current = () => {
    const center = slidingCenter(o, values.current.dock, values.current.slide);
    const last = sent.current;
    if ((last && last.join(",") === center.join(",")) || stillOffWindow(last, center)) return;
    sent.current = center;
    void setTrafficLightsCenter(windowId, center);
  };
  useEffect(() => {
    values.current.dock = currentValue(dock);
    const a = dock.addListener(({ value }) => {
      values.current.dock = value;
      apply.current();
    });
    apply.current();
    return () => {
      dock.removeListener(a);
      sent.current = undefined;
      void setTrafficLightsCenter(windowId, null);
    };
  }, [windowId, dock]);
  useEffect(() => {
    if (!o.peeking) return;
    const b = slide.addListener(({ value }) => {
      values.current.slide = value;
      latestOnSlide.current(value);
      apply.current();
    });
    return () => slide.removeListener(b);
  }, [slide, o.peeking]);
  useEffect(() => {
    if (!o.moving && values.current.dock !== currentValue(dock)) noteSidebarLightsLeftBehind();
  }, [dock, o.moving]);
  useEffect(() => apply.current(), [o.width, o.peeking, o.fullscreen, o.lights, o.right, o.peekAt.left, o.peekAt.top]);
}

export function slidingCenter(o: SidebarLights, dock: number, slide: number) {
  const offset = o.fullscreen ? 0 : o.peeking ? (o.width + 12) * (1 - slide) - o.peekAt.left : o.width * (1 - dock);
  return sidebarLightsCenter(o.right && !o.fullscreen, o.width, offset, o.peeking && !o.fullscreen ? o.peekAt.top : 0, o.lights);
}
