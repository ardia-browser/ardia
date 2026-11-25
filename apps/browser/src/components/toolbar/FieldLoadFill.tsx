import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { fieldGlowAvailable } from "../../state/tabs/fieldGlow";
import { continuousCorners, GradientFill } from "../ui";
import { driveFieldLoad, fieldLoadPlates, filledAt, frontOf, type Front, type LoadSink } from "./fieldLoadDrive";
import { FieldGlowFill, type FieldLoadFillProps } from "./FieldGlowFill";
import { FIELD_LOAD } from "./tokens";

const { motion } = FIELD_LOAD;
const EDGE_STOPS = [[0, 1], [1, 1]] as const;
const CORNER_TAPER = [0.09, 0.28, 0.52, 0.76, 0.96];

export const fieldRimRadius = (width: number, height: number, radius: number) => Math.min(Math.max(0, radius), width / 2, height / 2);

const cornerFade = (filled: Animated.Value, fade: readonly (readonly [number, number])[], width: number, extra: number, x: number) => filled.interpolate({
  inputRange: fade.map(([at]) => (x + width - at * (width + extra)) / width).reverse(),
  outputRange: fade.map(([, alpha]) => alpha).reverse(),
  extrapolate: "clamp",
});

type LoadValues = { filled: Animated.Value; opacity: Animated.Value; comet: Animated.Value; intensity: Animated.Value };

function animatedSink({ filled, opacity, comet, intensity }: LoadValues, front: () => Front): LoadSink {
  let leave: Animated.CompositeAnimation | null = null;
  let pulse: Animated.CompositeAnimation | null = null;
  opacity.setValue(0);
  return {
    show() {
      leave?.stop();
      leave = null;
      filled.setValue(0);
      comet.setValue(0);
      Animated.timing(opacity, { toValue: 1, ...motion.show, useNativeDriver: true }).start();
    },
    progress(progress, still) {
      if (!front().width) return;
      const to = filledAt(progress, front());
      if (still) filled.setValue(to);
      else Animated.timing(filled, { toValue: to, ...motion.progress, useNativeDriver: true }).start();
    },
    pulse(on) {
      pulse?.stop();
      pulse = null;
      intensity.setValue(0);
      if (!on) return;
      pulse = Animated.loop(Animated.timing(intensity, {
        toValue: 1, duration: FIELD_LOAD.pulse.period, easing: (t) => (1 - Math.cos(2 * Math.PI * t)) / 2,
        useNativeDriver: true, isInteraction: false,
      }));
      pulse.start();
    },
    finish(still) {
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
    },
    reset() {
      leave?.stop();
      opacity.stopAnimation();
      opacity.setValue(0);
    },
  };
}

const JsFieldLoadFill = memo(function JsFieldLoadFill({ tabId, color, height, radius }: FieldLoadFillProps) {
  const [width, setWidth] = useState(0);
  const values = useRef<LoadValues>({ filled: new Animated.Value(0), opacity: new Animated.Value(0), comet: new Animated.Value(0), intensity: new Animated.Value(0) }).current;
  const { tail } = frontOf(width);
  const front = useRef<Front>({ width, tail });
  front.current = { width, tail };
  const drive = useRef<ReturnType<typeof driveFieldLoad> | null>(null);

  useEffect(() => {
    drive.current = driveFieldLoad(tabId, animatedSink(values, () => front.current));
    return () => drive.current?.stop();
  }, [tabId]);
  useEffect(() => drive.current?.refit(), [width, tail]);

  const layers = useMemo(() => {
    if (!width) return null;
    const plates = fieldLoadPlates(width, height);
    const { filled, opacity, comet, intensity } = values;
    const brightness = intensity.interpolate({ inputRange: [0, 1], outputRange: [1, FIELD_LOAD.pulse.low] });
    const plate = (extra: number) => ({ position: "absolute", left: 0, top: 0, bottom: 0, width: width + extra }) as const;
    const corner = fieldRimRadius(width, height, radius);
    const travel = filled.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] });
    const steady = comet.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
    const rim = ({ fade, extra }: typeof plates.cap) => (
      <>
        <View style={{ position: "absolute", left: corner, right: corner, bottom: 0, height: FIELD_LOAD.line, overflow: "hidden" }}>
          <Animated.View style={{ position: "absolute", left: -corner, width: width + extra, height: FIELD_LOAD.line, transform: [{ translateX: travel }] }}>
            <GradientFill color={color} stops={EDGE_STOPS} fade={fade} style={StyleSheet.absoluteFill} />
          </Animated.View>
        </View>
        {corner > 0 && [false, true].map((right) => (
          <Animated.View key={Number(right)} style={{ position: "absolute", [right ? "right" : "left"]: 0, bottom: 0, width: corner, height: corner, overflow: "hidden", opacity: cornerFade(filled, fade, width, extra, right ? width - corner : corner) }}>
            {CORNER_TAPER.map((alpha, i) => {
              const bottom = corner * (1 - (i + 1) / CORNER_TAPER.length);
              return (
                <View key={alpha} style={{ position: "absolute", left: 0, right: 0, top: corner * i / CORNER_TAPER.length, bottom, opacity: alpha, overflow: "hidden" }}>
                  <View style={{ position: "absolute", [right ? "right" : "left"]: 0, bottom: -bottom, width, height, ...continuousCorners(corner), borderWidth: FIELD_LOAD.line, borderColor: color }} />
                </View>
              );
            })}
          </Animated.View>
        ))}
      </>
    );
    return (
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(opacity, brightness) }]}>
        <Animated.View style={{ ...plate(plates.tail.extra), transform: [{ translateX: travel }] }}>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: steady }]}>
            <GradientFill color={color} stops={plates.tail.stops} fade={plates.tail.fade} style={plate(plates.tail.extra)} />
            <GradientFill color={color} stops={plates.cap.stops.slice(0, -2)} fade={plates.cap.fade} style={plate(plates.cap.extra)} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet }]}>
            <GradientFill color={color} stops={plates.comet.stops.slice(0, -2)} fade={plates.comet.fade} style={plate(plates.comet.extra)} />
          </Animated.View>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: steady }]}>{rim(plates.cap)}</Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet }]}>{rim(plates.comet)}</Animated.View>
      </Animated.View>
    );
  }, [width, height, color, radius]);

  return (
    <View pointerEvents="none" onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[StyleSheet.absoluteFill, continuousCorners(radius), { overflow: "hidden" }]}>
      {layers}
    </View>
  );
});

export const FieldLoadFill = fieldGlowAvailable ? FieldGlowFill : JsFieldLoadFill;
