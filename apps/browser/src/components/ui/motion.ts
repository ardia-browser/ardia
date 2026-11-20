import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, type EasingFunction } from "react-native";
import { reduceMotion } from "./reduceMotion";

export const curve = {
  linear: Easing.linear,
  enter: Easing.out(Easing.cubic),
  exit: Easing.in(Easing.quad),
  move: Easing.inOut(Easing.quad),
  pulse: Easing.inOut(Easing.sin),
  outExpo: Easing.out(Easing.exp),
  fade: Easing.bezier(0.25, 0.46, 0.45, 0.94),
  cssEase: Easing.bezier(0.25, 0.1, 0.25, 1),
  cssEaseOut: Easing.bezier(0, 0, 0.58, 1),
} as const;

export const currentValue = (value: Animated.Value): number => (value as unknown as { __getValue(): number }).__getValue();

export const animating = (value: Animated.Value): boolean => (value as unknown as { _animation?: unknown })._animation != null;

export const gateLevel = (on: boolean) => (on ? 1 : 0);

export const gatedNode = (gate: Animated.Value, value: Animated.Value | Animated.AnimatedInterpolation<number>, rest: number) => Animated.add(rest, Animated.multiply(gate, Animated.subtract(value, rest)));

export function useGated(on: boolean, value: Animated.Value | Animated.AnimatedInterpolation<number>, rest: number) {
  const gate = useRef(new Animated.Value(gateLevel(on))).current;
  useLayoutEffect(() => gate.setValue(gateLevel(on)), [gate, on]);
  return useMemo(() => gatedNode(gate, value, rest), [gate, value, rest]);
}

export const duration = {
  fast: 100,
  base: 150,
  slow: 250,
  long: 400,
} as const;

export const period = { spinner: 900, pulse: 1100 } as const;

export type LoopLeg = { to: number; ms: number; easing?: EasingFunction };

export function legsEasing(legs: readonly LoopLeg[]): { duration: number; easing: EasingFunction } {
  const total = legs.reduce((sum, leg) => sum + leg.ms, 0);
  const easing = (t: number) => {
    let at = t * total;
    let from = 0;
    for (const [i, leg] of legs.entries()) {
      if (at < leg.ms || i === legs.length - 1) return from + (leg.to - from) * (leg.easing ?? curve.linear)(leg.ms > 0 ? Math.min(1, at / leg.ms) : 1);
      at -= leg.ms;
      from = leg.to;
    }
    return from;
  };
  return { duration: total, easing };
}

export function nativeLoop(value: Animated.Value, legs: readonly LoopLeg[], iterations = -1): Animated.CompositeAnimation {
  const { duration, easing } = legsEasing(legs);
  value.setValue(0);
  return Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true, isInteraction: false }), { iterations });
}

export const buttonMotion = { iconPressScale: 0.96, controlPressScale: 0.985 } as const;

export const reveal = {
  grow: { duration: 200, easing: curve.enter },
  shrink: { duration: duration.base, easing: curve.move },
  fadeIn: { duration: duration.base, easing: curve.enter, delay: 40 },
  fadeOut: { duration: duration.fast, easing: curve.exit },
} as const;

export const crossfade = { duration: duration.base, easing: curve.fade } as const;

export const anchoredOpen = { duration: 160, easing: curve.enter, fromScale: 0.97 } as const;

export const anchoredClose = { duration: 120, easing: curve.exit } as const;

export const selectionSlide = { duration: 90, easing: curve.enter } as const;

export const hoverFade = {
  show: { duration: 50, easing: curve.fade },
  hide: { duration: 200, easing: curve.fade },
  appear: { duration: duration.fast, easing: curve.fade },
} as const;

export type Fade = { duration: number; easing: EasingFunction; delay?: number };

export function usePresence<T>(value: T | null, motion: { show: Fade; hide: Fade }) {
  const showing = value !== null;
  const last = useRef(value);
  if (showing) last.current = value;
  const [mounted, setMounted] = useState(showing);
  if (showing && !mounted) setMounted(true);
  const appear = useRef(new Animated.Value(showing ? 1 : 0)).current;
  const heading = useRef(showing);
  useEffect(() => {
    if (heading.current === showing) return;
    heading.current = showing;
    const run = Animated.timing(appear, { toValue: showing ? 1 : 0, ...(showing ? motion.show : motion.hide), useNativeDriver: true });
    run.start(({ finished }) => finished && !showing && setMounted(false));
    return () => run.stop();
  }, [showing]);
  return { shown: showing || mounted ? last.current : null, appear };
}

export type SpringSpec = { response: number; damping: number };

export function spring({ response, damping }: SpringSpec) {
  const omega = (2 * Math.PI) / response;
  return { stiffness: omega * omega, damping: 2 * damping * omega, mass: 1 };
}

export const springSpec = {
  snappy: { response: 0.2, damping: 0.9 },
  smooth: { response: 0.4, damping: 0.85 },
  bouncy: { response: 0.3, damping: 0.6 },
} as const satisfies Record<string, SpringSpec>;

export const springs = {
  snappy: spring(springSpec.snappy),
  smooth: spring(springSpec.smooth),
  bouncy: spring(springSpec.bouncy),
} as const;

export function usePressScaleMotion(enabled = true, pressedScale: number = buttonMotion.iconPressScale) {
  const scale = useRef<Animated.Value | null>(null);
  if (enabled && !scale.current) scale.current = new Animated.Value(1);

  useEffect(() => {
    if (enabled) return;
    scale.current?.stopAnimation();
    scale.current?.setValue(1);
  }, [enabled]);

  const animate = (pressed: boolean) => {
    const value = scale.current;
    if (!enabled || !value) return;
    value.stopAnimation();
    if (reduceMotion() !== false) {
      value.setValue(1);
      return;
    }
    Animated.spring(value, { toValue: pressed ? pressedScale : 1, ...springs.snappy, useNativeDriver: true }).start();
  };

  return {
    scale: enabled ? scale.current : null,
    onPressIn: enabled ? () => animate(true) : undefined,
    onPressOut: enabled ? () => animate(false) : undefined,
  };
}

export function useHoverFill(shown: boolean, instant = false, fromMount = false) {
  const opacity = useRef<Animated.Value | null>(null);
  if ((shown || fromMount) && !opacity.current) opacity.current = new Animated.Value(shown && instant ? 1 : 0);
  useEffect(() => {
    const value = opacity.current;
    if (!value) return;
    if (instant || reduceMotion() !== false) {
      value.stopAnimation();
      value.setValue(shown ? 1 : 0);
      return;
    }
    const fade = Animated.timing(value, { toValue: shown ? 1 : 0, ...(shown ? hoverFade.show : hoverFade.hide), useNativeDriver: true });
    fade.start();
    return () => fade.stop();
  }, [shown, instant]);
  return opacity.current;
}
