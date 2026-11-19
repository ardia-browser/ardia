import { forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NativePagerConfig, NativeSwipeAreaProps } from "@ardia/ardiacore";
import type { EventSubscription } from "expo-modules-core";
import { View } from "react-native";
import { WindowIdContext } from "../engine/windowId";
import { noteFirstWindow, noteMissing } from "../missing";
import { requireNativeModule } from "../modules";
import { pagers } from "./index";
import { wheelSwipe } from "./wheel";
import type { PagerArea, PagerConfig, PagerStateEvent } from "./pager";

type KeyedConfig = PagerConfig & Pick<NativePagerConfig, "key">;

type SwipeWheelEvent = { type: "swipeWheel"; id: string; point: [number, number]; delta: number };
type WindowsSwipe = {
  setSwipeArea(id: string, key: string, on: boolean): Promise<void>;
  addListener(name: "onWindowEvent", listener: (event: { type: string } & Partial<SwipeWheelEvent>) => void): EventSubscription;
};

const windowsSwipe = () => requireNativeModule<WindowsSwipe>("ArdiaAppWindows");

let made = 0;

const whole = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback);

function readConfig(value: unknown): KeyedConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  if (typeof config.key !== "string" || config.key.length === 0) return null;
  const order = Array.isArray(config.order) && config.order.every((id) => typeof id === "string") ? (config.order as string[]) : undefined;
  const width = typeof config.width === "number" && Number.isFinite(config.width) ? config.width : 0;
  return { key: config.key, selected: whole(config.selected, 0), count: whole(config.count, 1), ack: whole(config.ack, 0), width, order };
}

export const SwipeArea = forwardRef<View, NativeSwipeAreaProps>(function SwipeArea(
  {
    canSwipeBack,
    canSwipeForward,
    tracksUnavailableDirections: _tracksUnavailableDirections,
    allowsVerticalMotion: _allowsVerticalMotion,
    isPager,
    wheelPages,
    onSwipe,
    nativePager,
    onPagerPosition,
    onPagerState,
    pointerEvents,
    onLayout,
    children,
    ...rest
  },
  ref,
) {
  const windowId = useContext(WindowIdContext);
  const areaKey = useRef(`swipe-${++made}`).current;
  const view = useRef<View | null>(null);
  const handlers = useRef({ onPagerPosition, onPagerState, onSwipe, canSwipeBack, canSwipeForward });
  handlers.current = { onPagerPosition, onPagerState, onSwipe, canSwipeBack, canSwipeForward };
  const area = useMemo<PagerArea>(
    () => ({
      position(position: number) {
        const handler = handlers.current.onPagerPosition;
        if (!handler) return false;
        handler({ nativeEvent: { position } });
        return true;
      },
      state(event: PagerStateEvent) {
        handlers.current.onPagerState?.({ nativeEvent: event });
      },
    }),
    [],
  );
  const config = readConfig(nativePager);
  const key = config?.key;
  const paging = !!isPager && !!wheelPages && !!windowId;

  useEffect(() => {
    noteFirstWindow();
    noteMissing("<ArdiaSwipe> finger-following swipe");
  }, []);

  useLayoutEffect(() => {
    if (!key) return;
    const pager = pagers.named(key);
    pager.attach(area);
    return () => pager.detach(area);
  }, [key, area]);

  useLayoutEffect(() => {
    if (config) pagers.existing(config.key)?.configure(config);
  }, [key, config?.selected, config?.count, config?.ack, config?.width, config?.order]);

  useEffect(() => {
    if (!paging) return;
    void windowsSwipe().setSwipeArea(windowId, areaKey, true).catch(() => {});
    const subscription = windowsSwipe().addListener("onWindowEvent", (event) => {
      if (event.type !== "swipeWheel" || event.id !== windowId || typeof event.delta !== "number" || !Array.isArray(event.point)) return;
      const [x, y] = event.point;
      const delta = event.delta;
      view.current?.measureInWindow((left, top, width, height) => {
        if (width <= 0 || height <= 0 || x < left || y < top || x >= left + width || y >= top + height) return;
        const { onSwipe: swipe, canSwipeBack: back, canSwipeForward: forward } = handlers.current;
        swipe?.({ nativeEvent: wheelSwipe(delta, back, forward, width) });
      });
    });
    return () => {
      subscription.remove();
      void windowsSwipe().setSwipeArea(windowId, areaKey, false).catch(() => {});
    };
  }, [paging, windowId, areaKey]);

  const setRef = useCallback(
    (node: View | null) => {
      view.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <View {...rest} ref={setRef} onLayout={onLayout} pointerEvents={pointerEvents ?? "box-none"}>
      {children}
    </View>
  );
});
