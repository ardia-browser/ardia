import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Easing, type EasingFunction } from "react-native";
import { reduceMotion } from "./reduceMotion";
import { pressMotionNow, subscribePressMotion, type PressMotion } from "../../lib/pressMotion";

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

export const bouncePressMotion = {
  iconPressScale: 0.9,
  controlPressScale: 0.97,
  rowPressScale: 0.975,
  tilePressScale: 0.94,
  shortestMs: 90,
  restDisplacementThreshold: 0.0001,
  restSpeedThreshold: 0.0001,
} as const;

export const pressReleaseDelay = (heldMs: number) => Math.max(0, bouncePressMotion.shortestMs - heldMs);

export function bounceDip(pressedScale: number): number {
  if (pressedScale === buttonMotion.iconPressScale) return bouncePressMotion.iconPressScale;
  if (pressedScale === buttonMotion.controlPressScale) return bouncePressMotion.controlPressScale;
  return pressedScale;
}

export const usePressMotion = (): PressMotion => useSyncExternalStore(subscribePressMotion, pressMotionNow, pressMotionNow);

export const hoverFade = {
  show: { duration: 50, easing: curve.fade },
  hide: { duration: 200, easing: curve.fade },
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
  press: { response: 0.12, damping: 1 },
  release: { response: 0.28, damping: 0.55 },
} as const satisfies Record<string, SpringSpec>;

export const springs = {
  snappy: spring(springSpec.snappy),
  smooth: spring(springSpec.smooth),
  bouncy: spring(springSpec.bouncy),
  press: spring(springSpec.press),
  release: spring(springSpec.release),
} as const;

export const liftSpring = () => (pressMotionNow() === "bounce" && reduceMotion() === false ? springs.bouncy : springs.snappy);

export function usePressScaleMotion(enabled = true, pressedScale: number = buttonMotion.iconPressScale) {
  const scale = useRef<Animated.Value | null>(null);
  const pressedAt = useRef(0);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (enabled && !scale.current) scale.current = new Animated.Value(1);

  const cancelRelease = () => {
    if (release.current) clearTimeout(release.current);
    release.current = null;
  };

  useEffect(() => {
    if (enabled) return;
    cancelRelease();
    scale.current?.stopAnimation();
    scale.current?.setValue(1);
  }, [enabled]);

  useEffect(() => cancelRelease, []);

  const settle = (value: Animated.Value, pressed: boolean) => {
    const { restDisplacementThreshold, restSpeedThreshold } = bouncePressMotion;
    Animated.spring(value, { toValue: pressed ? bounceDip(pressedScale) : 1, ...(pressed ? springs.press : springs.release), restDisplacementThreshold, restSpeedThreshold, useNativeDriver: true }).start();
  };

  const still = (value: Animated.Value, pressed: boolean) => {
    Animated.spring(value, { toValue: pressed ? pressedScale : 1, ...springs.snappy, useNativeDriver: true }).start();
  };

  const bounce = (value: Animated.Value, pressed: boolean) => {
    if (pressed) {
      pressedAt.current = Date.now();
      settle(value, true);
      return;
    }
    const wait = pressReleaseDelay(Date.now() - pressedAt.current);
    if (!wait) return settle(value, false);
    release.current = setTimeout(() => {
      release.current = null;
      if (pressMotionNow() === "bounce") settle(value, false);
      else still(value, false);
    }, wait);
  };

  const animate = (pressed: boolean) => {
    const value = scale.current;
    cancelRelease();
    if (!enabled || !value) return;
    if (reduceMotion() !== false) {
      value.stopAnimation();
      value.setValue(1);
      return;
    }
    if (pressMotionNow() === "bounce") return bounce(value, pressed);
    value.stopAnimation();
    still(value, pressed);
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
