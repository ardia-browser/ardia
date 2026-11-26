import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { Animated } from "react-native";
import { curve, duration } from "../ui/motion";
import { onboardingMotion } from "./tokens";

const GLIDE = { duration: onboardingMotion.layoutShift, easing: curve.enter, useNativeDriver: true, isInteraction: false } as const;

export type Feed<T> = { get: () => T; put: (next: T) => void; subscribe: (listener: () => void) => () => void };

export function createFeed<T>(initial: T): Feed<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    put: (next) => {
      if (next === value) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const CALM_FRAMES = 2;
const waiting = new Set<() => void>();
const frames = { began: 0, last: 0, shortest: Infinity, calm: 0, handle: 0 };

function tick() {
  const now = Date.now();
  const gap = now - frames.last;
  frames.last = now;
  frames.shortest = Math.min(frames.shortest, gap);
  frames.calm = gap <= frames.shortest * 2 ? frames.calm + 1 : 0;
  if (frames.calm < CALM_FRAMES && now - frames.began < GLIDE.duration) {
    frames.handle = requestAnimationFrame(tick);
    return;
  }
  const due = [...waiting];
  waiting.clear();
  due.forEach((run) => run());
}

function whenCalm(run: () => void) {
  waiting.add(run);
  if (waiting.size === 1) {
    const now = Date.now();
    Object.assign(frames, { began: now, last: now, shortest: Infinity, calm: 0, handle: requestAnimationFrame(tick) });
  } else frames.calm = 0;
  return () => {
    waiting.delete(run);
    if (!waiting.size) cancelAnimationFrame(frames.handle);
  };
}

export function useGlide(target: number, onSettled?: (target: number) => void) {
  const value = useRef(new Animated.Value(target)).current;
  const aimed = useRef(target);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useLayoutEffect(() => {
    if (aimed.current === target) return;
    aimed.current = target;
    return whenCalm(() =>
      Animated.timing(value, { ...GLIDE, toValue: target }).start(({ finished }) => {
        if (finished && aimed.current === target) settled.current?.(target);
      }),
    );
  }, [target]);
  useEffect(() => () => value.stopAnimation(), [value]);
  return value;
}

type Track = { from: number; to: number; at: number };

const fadeMs = (to: number) => (to ? GLIDE.duration : duration.base);

export type SwapLayer<T> = { slot: number; key: string; item: T; live: boolean; opacity: Animated.Value; track: Track; gen: number; ran: number };

const levelAt = (track: Track, at: number) => track.from + (track.to - track.from) * curve.enter(Math.min(1, Math.max(0, (at - track.at) / fadeMs(track.to))));

function aim<T>(layer: SwapLayer<T>, live: boolean, at: number) {
  const to = live ? 1 : 0;
  if (layer.live === live && layer.track.to === to) return;
  layer.track = { from: levelAt(layer.track, at), to, at: Infinity };
  layer.live = live;
  layer.gen += 1;
}

function retarget<T>(layers: SwapLayer<T>[], item: T | null, key: string | null, at: number): SwapLayer<T>[] {
  for (const layer of layers) aim(layer, false, at);
  if (item === null || key === null) return [...layers];
  const same = layers.find((l) => l.key === key);
  if (same) {
    same.item = item;
    aim(same, true, at);
    return [...layers];
  }
  if (layers.length < 2) {
    const slot = layers.some((l) => l.slot === 0) ? 1 : 0;
    return [...layers, { slot, key, item, live: true, opacity: new Animated.Value(0), track: { from: 0, to: 1, at: Infinity }, gen: 1, ran: 0 }];
  }
  const quietest = layers.reduce((a, b) => (levelAt(a.track, at) <= levelAt(b.track, at) ? a : b));
  quietest.key = key;
  quietest.item = item;
  aim(quietest, true, at);
  return [...layers];
}

export function useSwap<T>(item: T | null, keyOf: (item: T) => string): SwapLayer<T>[] {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const key = item === null ? null : keyOf(item);
  const box = useRef<{ key: string | null; layers: SwapLayer<T>[] } | null>(null);
  if (!box.current) {
    const first: SwapLayer<T>[] = item === null || key === null ? [] : [{ slot: 0, key, item, live: true, opacity: new Animated.Value(1), track: { from: 1, to: 1, at: 0 }, gen: 0, ran: 0 }];
    box.current = { key, layers: first };
  }
  const state = box.current;
  if (key !== state.key) {
    state.key = key;
    state.layers = retarget(state.layers, item, key, Date.now());
  } else if (item !== null) {
    const live = state.layers.find((l) => l.live);
    if (live) live.item = item;
  }
  useLayoutEffect(() => {
    const due = state.layers.filter((l) => l.ran !== l.gen);
    if (!due.length) return;
    return whenCalm(() => {
      for (const layer of due) {
        if (layer.ran === layer.gen || !state.layers.includes(layer)) continue;
        layer.ran = layer.gen;
        layer.track.at = Date.now();
        const gen = layer.gen;
        Animated.timing(layer.opacity, { ...GLIDE, toValue: layer.track.to, duration: fadeMs(layer.track.to) }).start(({ finished }) => {
          if (!finished || layer.gen !== gen || layer.live) return;
          state.layers = state.layers.filter((l) => l !== layer);
          redraw();
        });
      }
    });
  });
  useEffect(() => () => state.layers.forEach((l) => l.opacity.stopAnimation()), [state]);
  return [...state.layers].sort((a, b) => a.slot - b.slot);
}
