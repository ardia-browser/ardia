import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { Animated } from "react-native";
import { EDGE_FADE, EDGE_FADE_FLOOR, EDGE_FADE_ONSET } from "./tokens";

export type Place = () => readonly [left: number, width: number] | null;
type Entry = { id: string; start: Animated.Value; end: Animated.Value; place: Place; last: readonly [number, number] };

export type EdgeFade = {
  scrollX: Animated.Value;
  viewport: Animated.Value;
  maxScroll: Animated.Value;
  rightEdge: Animated.AnimatedAddition<number>;
  scrolled: Animated.AnimatedInterpolation<number>;
  remaining: Animated.AnimatedInterpolation<number>;
  entries: Set<Entry>;
  origin: number;
};

const clamp = { extrapolate: "clamp" as const };
const OFFSTAGE = -1e6;

export function createEdgeFade(scrollX: Animated.Value): EdgeFade {
  const viewport = new Animated.Value(0);
  const maxScroll = new Animated.Value(0);
  return {
    scrollX,
    viewport,
    maxScroll,
    rightEdge: Animated.add(scrollX, viewport),
    scrolled: scrollX.interpolate({ inputRange: [0, EDGE_FADE_ONSET], outputRange: [0, 1], ...clamp }),
    remaining: Animated.subtract(maxScroll, scrollX).interpolate({ inputRange: [0, EDGE_FADE_ONSET], outputRange: [0, 1], ...clamp }),
    entries: new Set(),
    origin: 0,
  };
}

const spanOf = (fade: EdgeFade, place: Place): readonly [number, number] => {
  const p = place();
  return p ? [fade.origin + p[0], fade.origin + p[0] + p[1]] : [OFFSTAGE, OFFSTAGE];
};

function refreshEntry(fade: EdgeFade, entry: Entry) {
  const span = spanOf(fade, entry.place);
  if (Math.abs(span[0] - entry.last[0]) < 0.25 && Math.abs(span[1] - entry.last[1]) < 0.25) return;
  entry.last = span;
  entry.start.setValue(span[0]);
  entry.end.setValue(span[1]);
}

export function refreshEdgeFade(fade: EdgeFade, origin: number) {
  fade.origin = origin;
  for (const entry of fade.entries) refreshEntry(fade, entry);
}

export const EdgeFadeContext = createContext<EdgeFade | null>(null);

export function edgeOpacityAt(scroll: number, start: number, end: number, viewport: number, content: number): number {
  const ramp = (x: number) => Math.max(0, Math.min(1, x));
  const last = Math.max(0, content - viewport);
  const left = ramp(1 - (start - scroll) / EDGE_FADE) * ramp(scroll / EDGE_FADE_ONSET);
  const right = ramp(1 - (scroll + viewport - end) / EDGE_FADE) * ramp((last - scroll) / EDGE_FADE_ONSET);
  return 1 - (1 - EDGE_FADE_FLOOR) * Math.min(1, left + right);
}

export function useEdgeOpacity(id: string, place: Place): Animated.AnimatedInterpolation<number> | 1 {
  const fade = useContext(EdgeFadeContext);
  const latest = useRef(place);
  latest.current = place;
  const entry = useMemo<Entry | null>(() => {
    if (!fade) return null;
    const span = spanOf(fade, () => latest.current());
    return { id, start: new Animated.Value(span[0]), end: new Animated.Value(span[1]), place: () => latest.current(), last: span };
  }, [fade, id]);
  const opacity = useMemo(() => {
    if (!fade || !entry) return 1;
    const left = Animated.subtract(entry.start, fade.scrollX).interpolate({ inputRange: [0, EDGE_FADE], outputRange: [1, 0], ...clamp });
    const right = Animated.subtract(fade.rightEdge, entry.end).interpolate({ inputRange: [0, EDGE_FADE], outputRange: [1, 0], ...clamp });
    return Animated.add(Animated.multiply(left, fade.scrolled), Animated.multiply(right, fade.remaining)).interpolate({ inputRange: [0, 1], outputRange: [1, EDGE_FADE_FLOOR], ...clamp });
  }, [fade, entry]);
  useLayoutEffect(() => {
    if (!fade || !entry) return;
    fade.entries.add(entry);
    refreshEntry(fade, entry);
    return () => void fade.entries.delete(entry);
  }, [fade, entry]);
  return opacity;
}

export const fadeEntries = (fade: EdgeFade) => [...fade.entries].map((e) => ({ id: e.id, start: e.last[0], end: e.last[1], centre: (e.last[0] + e.last[1]) / 2 }));
