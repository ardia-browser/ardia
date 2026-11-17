import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { Animated, Easing, Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

export type MotionTarget = { opacity?: number; translateX?: number; translateY?: number; scale?: number; cornerRadius?: number };

export type MotionCurve =
  | { type: "timing"; durationMs: number; curve?: [number, number, number, number] }
  | { type: "spring"; response: number; dampingFraction: number };

export type MotionViewProps = ViewProps & {
  to: MotionTarget;
  from?: MotionTarget;
  motion: MotionCurve;
  onMotionEnd?: (finished: boolean) => void;
  nearEndPx?: number;
  onMotionNearEnd?: (remainingPx: number) => void;
  children?: ReactNode;
};

type NativeProps = Omit<MotionViewProps, "onMotionEnd" | "onMotionNearEnd"> & {
  onMotionEnd?: (event: NativeSyntheticEvent<{ finished: boolean }>) => void;
  onMotionNearEnd?: (event: NativeSyntheticEvent<{ remainingPx: number }>) => void;
};

const reportsNearEnd = Platform.OS === "android";

export const motionReportsNearEnd = () => reportsNearEnd && motionRunsInRenderServer();

const native = requireOptionalNativeModule<{ runsInRenderServer?: boolean }>("ArdiaPhoneMotion");

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneMotion"));

export const motionRunsInRenderServer = () => native?.runsInRenderServer === true;

const filled = (to: MotionTarget) => ({ opacity: to.opacity ?? 1, translateX: to.translateX ?? 0, translateY: to.translateY ?? 0, scale: to.scale ?? 1, cornerRadius: to.cornerRadius });

export function MotionView({ to, from, motion, onMotionEnd, nearEndPx, onMotionNearEnd, ...rest }: MotionViewProps) {
  if (motionRunsInRenderServer()) {
    const near = reportsNearEnd ? { nearEndPx, onMotionNearEnd: onMotionNearEnd ? (event: NativeSyntheticEvent<{ remainingPx: number }>) => onMotionNearEnd(event.nativeEvent.remainingPx) : undefined } : {};
    return createElement(view(), { ...rest, ...near, to: filled(to), from: from ? filled(from) : undefined, motion, onMotionEnd: onMotionEnd ? (event: NativeSyntheticEvent<{ finished: boolean }>) => onMotionEnd(event.nativeEvent.finished) : undefined });
  }
  return createElement(AnimatedMotionView, { to, from, motion, onMotionEnd, ...rest });
}

function animation(value: Animated.Value, toValue: number, motion: MotionCurve) {
  if (motion.type === "spring") {
    const response = Math.max(motion.response, 0.01);
    const stiffness = (2 * Math.PI / response) ** 2;
    const damping = (4 * Math.PI * motion.dampingFraction) / response;
    return Animated.spring(value, { toValue, stiffness, damping, mass: 1, useNativeDriver: true });
  }
  const [x1, y1, x2, y2] = motion.curve ?? [0, 0, 0.58, 1];
  return Animated.timing(value, { toValue, duration: motion.durationMs, easing: Easing.bezier(x1, y1, x2, y2), useNativeDriver: true });
}

function AnimatedMotionView({ to, from, motion, onMotionEnd, style, ...rest }: MotionViewProps) {
  const { cornerRadius, ...target } = filled(to);
  const { cornerRadius: _startRadius, ...start } = filled(from ?? to);
  const values = useRef({ opacity: new Animated.Value(start.opacity), translateX: new Animated.Value(start.translateX), translateY: new Animated.Value(start.translateY), scale: new Animated.Value(start.scale) }).current;
  const shown = useRef(start);
  useEffect(() => {
    const before = shown.current;
    shown.current = target;
    const moves = (Object.keys(target) as (keyof typeof target)[]).filter((key) => before[key] !== target[key]);
    if (moves.length === 0) return;
    const run = Animated.parallel(moves.map((key) => animation(values[key], target[key], motion)));
    run.start(({ finished }) => onMotionEnd?.(finished));
    return () => run.stop();
  }, [target.opacity, target.translateX, target.translateY, target.scale]);
  return createElement(Animated.View, {
    ...rest,
    style: [style, cornerRadius === undefined ? null : { borderRadius: cornerRadius, borderCurve: "continuous", overflow: "hidden" }, { opacity: values.opacity, transform: [{ translateX: values.translateX }, { translateY: values.translateY }, { scale: values.scale }] }],
  });
}
