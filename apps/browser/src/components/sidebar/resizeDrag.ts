import { Animated, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { springs } from "../ui/motion";

const BAND = 36;
const BAND_SCALE = 90;

export type ResizeBounds = { min: number; max: number };

const band = (over: number) => BAND * (1 - Math.exp(-over / BAND_SCALE));
const unband = (stretch: number) => -BAND_SCALE * Math.log(1 - Math.min(stretch, BAND - 0.01) / BAND);

export function rubberBand(width: number, { min, max }: ResizeBounds): number {
  if (width > max) return max + band(width - max);
  if (width < min) return min - band(min - width);
  return width;
}

export function unstretch(width: number, { min, max }: ResizeBounds): number {
  if (width > max) return max + unband(width - max);
  if (width < min) return min - unband(min - width);
  return width;
}

export const clampWidth = (width: number, { min, max }: ResizeBounds) => Math.min(max, Math.max(min, width));

export const grabbedWidth = (width: number, direction: 1 | -1, pointerFromEdge: number) => width + direction * pointerFromEdge;

export type ResizeDragOptions = ResizeBounds & {
  direction: 1 | -1;
  saved: () => number;
  pointerFromEdge?: (e: GestureResponderEvent) => number;
  onLive: (width: number | null) => void;
  onCommit: (width: number, dragged: boolean) => void;
};

export function resizeGesture(latest: { current: ResizeDragOptions }) {
  let live: number | null = null;
  let rest = 0;
  let grabbed = 0;
  let dragged = false;
  let spring: Animated.CompositeAnimation | null = null;
  const show = (width: number) => {
    live = width;
    latest.current.onLive(width);
  };
  const commit = (width: number) => {
    live = null;
    latest.current.onCommit(width, dragged);
    latest.current.onLive(null);
  };
  const at = (dx: number) => rubberBand((dragged ? grabbed : rest) + latest.current.direction * dx, latest.current);
  return {
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: (e: GestureResponderEvent) => {
      const { saved, direction, pointerFromEdge } = latest.current;
      const width = live ?? saved();
      dragged = live !== null;
      spring?.stop();
      spring = null;
      rest = unstretch(width, latest.current);
      grabbed = unstretch(grabbedWidth(width, direction, pointerFromEdge?.(e) ?? 0), latest.current);
      show(at(0));
    },
    onPanResponderMove: (_: GestureResponderEvent, g: PanResponderGestureState) => {
      if (g.dx !== 0) dragged = true;
      show(at(g.dx));
    },
    onPanResponderRelease: (_: GestureResponderEvent, g: PanResponderGestureState) => {
      const raw = at(g.dx);
      const target = clampWidth(raw, latest.current);
      if (raw === target) return commit(target);
      const value = new Animated.Value(raw);
      value.addListener(({ value: v }) => show(v));
      const mine = Animated.spring(value, { toValue: target, ...springs.bouncy, useNativeDriver: false });
      spring = mine;
      mine.start(({ finished }) => {
        value.removeAllListeners();
        if (!finished) return;
        spring = null;
        commit(target);
      });
    },
    onPanResponderTerminate: () => commit(clampWidth(live ?? latest.current.saved(), latest.current)),
    onPanResponderTerminationRequest: () => false,
  };
}
