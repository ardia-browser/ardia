import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { watchLastingLoad } from "../../state/tabs/lastingLoad";
import { pageProgressOf, watchPageProgress } from "../../state/tabs/pageProgress";
import { notePageOverlay } from "../../state/telemetry/usage";
import { GradientFill, reduceMotion, type GradientStop } from "../ui";
import { FIELD_LOAD } from "./tokens";

const { floor, motion } = FIELD_LOAD;

const lined = (glow: readonly GradientStop[], height: number): GradientStop[] => {
  const lineTop = 1 - FIELD_LOAD.line / height;
  return [...glow.map(([at, alpha]) => [at * lineTop, alpha] as const), [lineTop, 1], [1, 1]];
};
const TAIL_GLOW: GradientStop[] = FIELD_LOAD.glow.map(([at, alpha]) => [at, Math.min(alpha, FIELD_LOAD.tailCeiling)]);
const CAP_GLOW: GradientStop[] = FIELD_LOAD.glow.map(([at, alpha]) => [at, alpha - Math.min(alpha, FIELD_LOAD.tailCeiling)]);
const fadingPast = (body: number, front: number, falloff: readonly number[]): GradientStop[] => [
  [0, 1],
  ...falloff.map((alpha, i) => [(body + (front * i) / (falloff.length - 1)) / (body + front), alpha] as const),
];

export type LoadValues = { filled: Animated.Value; opacity: Animated.Value; comet: Animated.Value };
type Front = { width: number; tail: number };

export function driveFieldLoad(tabId: string, values: LoadValues, front: () => Front): { refit: () => void; stop: () => void } {
  const { filled, opacity, comet } = values;
  let shown = false;
  let leave: Animated.CompositeAnimation | null = null;
  const refit = () => {
    const { width, tail } = front();
    if (!shown || !width) return;
    const to = Math.max(floor, Math.min(pageProgressOf(tabId), 1 - tail / width));
    if (reduceMotion()) filled.setValue(to);
    else Animated.timing(filled, { toValue: to, ...motion.progress, useNativeDriver: true }).start();
  };
  const show = () => {
    shown = true;
    leave?.stop();
    leave = null;
    notePageOverlay("loadingField");
    filled.setValue(0);
    comet.setValue(0);
    Animated.timing(opacity, { toValue: 1, ...motion.show, useNativeDriver: true }).start();
    refit();
  };
  const finish = () => {
    shown = false;
    const still = reduceMotion();
    if (still) {
      filled.setValue(1);
      comet.setValue(1);
    }
    const sweep = Animated.parallel([
      Animated.timing(filled, { toValue: 1, ...motion.finish, useNativeDriver: true }),
      Animated.timing(comet, { toValue: 1, ...motion.finish, useNativeDriver: true }),
    ]);
    leave = Animated.sequence([...(still ? [] : [sweep]), Animated.delay(motion.hold), Animated.timing(opacity, { toValue: 0, ...motion.hide, useNativeDriver: true })]);
    leave.start();
  };
  opacity.setValue(0);
  const stopLoad = watchLastingLoad(tabId, (lasting) => (lasting ? show() : finish()));
  const stopProgress = watchPageProgress(tabId, refit);
  return {
    refit,
    stop: () => {
      stopLoad();
      stopProgress();
      leave?.stop();
      opacity.stopAnimation();
      opacity.setValue(0);
    },
  };
}

export const FieldLoadFill = memo(function FieldLoadFill({ tabId, color, height, radius }: { tabId: string; color: string; height: number; radius: number }) {
  const [width, setWidth] = useState(0);
  const values = useRef<LoadValues>({ filled: new Animated.Value(0), opacity: new Animated.Value(0), comet: new Animated.Value(0) }).current;
  const frontScale = Math.min(1, (width * FIELD_LOAD.frontShareOfField) / FIELD_LOAD.tail);
  const tail = FIELD_LOAD.tail * frontScale;
  const cap = FIELD_LOAD.cap * frontScale;
  const front = useRef<Front>({ width, tail });
  front.current = { width, tail };
  const drive = useRef<ReturnType<typeof driveFieldLoad> | null>(null);

  useEffect(() => {
    drive.current = driveFieldLoad(tabId, values, () => front.current);
    return () => drive.current?.stop();
  }, [tabId]);
  useEffect(() => drive.current?.refit(), [width, tail]);

  const layers = useMemo(() => {
    if (!width) return null;
    const stops = lined(FIELD_LOAD.glow, height);
    const capStops = lined(CAP_GLOW, height);
    const tailFade = fadingPast(width, tail, FIELD_LOAD.tailFade);
    const capFade = fadingPast(width, cap, FIELD_LOAD.capFade);
    const cometFade: GradientStop[] = [[0, 0], ...capFade.slice(1)];
    const { filled, opacity, comet } = values;
    return (
      <Animated.View
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width + tail, opacity, transform: [{ translateX: filled.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
          <GradientFill color={color} stops={TAIL_GLOW} fade={tailFade} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width + tail }} />
          <GradientFill color={color} stops={capStops} fade={capFade} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width + cap }} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet }]}>
          <GradientFill color={color} stops={stops} fade={cometFade} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width + cap }} />
        </Animated.View>
      </Animated.View>
    );
  }, [width, tail, cap, height, color]);

  return (
    <View pointerEvents="none" onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]}>
      {layers}
    </View>
  );
});
