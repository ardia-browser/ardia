import { Children, cloneElement, forwardRef, isValidElement, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, View, type ViewProps } from "react-native";

const STEP_MS = 150;
const START_SCALE = 0.12;
const GROW_OMEGA = (2 * Math.PI) / 0.2;
const GROW = { stiffness: GROW_OMEGA * GROW_OMEGA, damping: 2 * 0.9 * GROW_OMEGA, mass: 1, overshootClamping: true, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.01 };
const HIDDEN = { display: "none" } as const;
const NATIVE_DRIVER = false;

type Phase = "waiting" | "entering" | "open" | "closing" | "promoting" | "finished";
type Outcome = "closed" | "promoted";
type Rect = { x: number; y: number; width: number; height: number };
type Geometry = { width: number; height: number; card: Rect; source: Rect; fullscreen: boolean };
type Event<T> = (event: { nativeEvent: T }) => void;
type StageState = { generation: number; phase: Phase; entrance: "affine" | "fade"; interrupted: boolean; readyTimedOut: boolean };

type Props = ViewProps & {
  geometry?: Geometry;
  reduceMotion?: boolean;
  onPeekState?: Event<StageState>;
  onPeekDone?: Event<{ generation: number; outcome: Outcome }>;
  children?: ReactNode;
};

const timed = (value: Animated.Value, toValue: number, easing: (t: number) => number) =>
  Animated.timing(value, { toValue, duration: STEP_MS, easing, useNativeDriver: NATIVE_DRIVER });

export const PeekStage = forwardRef<unknown, Props>(function PeekStage({ geometry, reduceMotion, onPeekState, onPeekDone, children, style, ...rest }, ref) {
  const [progress] = useState(() => new Animated.Value(0));
  const [expand] = useState(() => new Animated.Value(0));
  const now = useRef({ generation: 0, phase: "waiting" as Phase });
  const latest = useRef({ onPeekState, onPeekDone, reduceMotion });
  latest.current = { onPeekState, onPeekDone, reduceMotion };
  const fade = !!reduceMotion;

  const announce = (phase: Phase) => {
    now.current.phase = phase;
    const entrance = latest.current.reduceMotion ? "fade" : "affine";
    latest.current.onPeekState?.({ nativeEvent: { generation: now.current.generation, phase, entrance, interrupted: false, readyTimedOut: false } });
  };
  const finish = (generation: number, outcome: Outcome) => {
    if (generation !== now.current.generation || now.current.phase === "finished") return;
    announce("finished");
    latest.current.onPeekDone?.({ nativeEvent: { generation, outcome } });
  };
  const live = () => now.current.phase !== "finished" && now.current.phase !== "closing" && now.current.phase !== "promoting";

  useImperativeHandle(ref, () => ({
    begin: (generation: number, animated = true) => {
      if (generation <= now.current.generation) return Promise.resolve(false);
      now.current.generation = generation;
      announce("entering");
      progress.stopAnimation();
      expand.stopAnimation();
      expand.setValue(0);
      const opened = () => generation === now.current.generation && now.current.phase === "entering" && announce("open");
      if (!animated) {
        progress.setValue(1);
        opened();
      } else if (latest.current.reduceMotion) timed(progress, 1, Easing.out(Easing.cubic)).start(opened);
      else Animated.spring(progress, { toValue: 1, ...GROW, useNativeDriver: NATIVE_DRIVER }).start(opened);
      return Promise.resolve(true);
    },
    close: (generation: number) => {
      if (generation !== now.current.generation || !live()) return Promise.resolve(false);
      announce("closing");
      progress.stopAnimation();
      timed(progress, 0, Easing.in(Easing.quad)).start(() => finish(generation, "closed"));
      return Promise.resolve(true);
    },
    promote: (generation: number) => {
      if (generation !== now.current.generation || !live()) return Promise.resolve(false);
      announce("promoting");
      progress.stopAnimation();
      progress.setValue(1);
      if (latest.current.reduceMotion) finish(generation, "promoted");
      else timed(expand, 1, Easing.out(Easing.cubic)).start(() => finish(generation, "promoted"));
      return Promise.resolve(true);
    },
  }));

  const [scrim, chrome, page] = Children.toArray(children);
  const layer = (child: ReactNode) => (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {child}
    </View>
  );

  const full = !geometry || geometry.fullscreen;
  const width = geometry?.width ?? 0;
  const height = geometry?.height ?? 0;
  const card = full ? { x: 0, y: 0, width, height } : geometry.card;
  const source = geometry?.source ?? card;
  const centerX = card.x + card.width / 2;
  const centerY = card.y + card.height / 2;
  const fromX = source.x + source.width / 2;
  const fromY = source.y + source.height / 2;
  const still = fade || full;
  const grown = (to: number) => progress.interpolate({ inputRange: [0, 1], outputRange: [START_SCALE, to] });
  const scaleX = still ? 1 : Animated.multiply(grown(1), expand.interpolate({ inputRange: [0, 1], outputRange: [1, width / Math.max(card.width, 1)] }));
  const scaleY = still ? 1 : Animated.multiply(grown(1), expand.interpolate({ inputRange: [0, 1], outputRange: [1, height / Math.max(card.height, 1)] }));
  const translateX = still
    ? 0
    : Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [fromX - centerX, 0] }), expand.interpolate({ inputRange: [0, 1], outputRange: [0, width / 2 - centerX] }));
  const translateY = still ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [fromY - centerY, 0] });
  const cardOpacity = full ? 1 : fade ? progress : progress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 1, 1] });
  const dim = full ? 0 : Animated.multiply(progress, expand.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }));
  const tabScale = expand.interpolate({ inputRange: [0, 1], outputRange: [1, (width / Math.max(card.width, 1) + height / Math.max(card.height, 1)) / 2] });
  const zoomed = (child: ReactNode) => (!full && isValidElement<{ zoom?: unknown }>(child) ? cloneElement(child, { zoom: { toTab: expand, grown: tabScale } }) : child);

  return (
    <View {...rest} style={style} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: dim }, full && HIDDEN]} pointerEvents="box-none">
        {scrim}
      </Animated.View>
      <Animated.View
        pointerEvents="box-none"
        style={{ position: "absolute", left: card.x, top: card.y, width: card.width, height: card.height, opacity: cardOpacity, transform: [{ translateX }, { translateY }, { scaleX }, { scaleY }] }}
      >
        <View pointerEvents="box-none" style={{ position: "absolute", left: -card.x, top: -card.y, width, height }}>
          <View style={[StyleSheet.absoluteFill, full && HIDDEN]} pointerEvents="box-none">
            {chrome !== undefined && zoomed(chrome)}
          </View>
          {page !== undefined && layer(zoomed(page))}
        </View>
      </Animated.View>
    </View>
  );
});
