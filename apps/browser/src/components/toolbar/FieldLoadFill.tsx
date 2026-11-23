import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { fieldGlowAvailable } from "../../state/tabs/fieldGlow";
import { GradientFill } from "../ui";
import { driveFieldLoad, fieldLoadPlates, filledAt, frontOf, type Front, type LoadSink } from "./fieldLoadDrive";
import { FieldGlowFill, type FieldLoadFillProps } from "./FieldGlowFill";
import { FIELD_LOAD } from "./tokens";

const { motion } = FIELD_LOAD;

type LoadValues = { filled: Animated.Value; opacity: Animated.Value; comet: Animated.Value };

function animatedSink({ filled, opacity, comet }: LoadValues, front: () => Front): LoadSink {
  let leave: Animated.CompositeAnimation | null = null;
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
  const values = useRef<LoadValues>({ filled: new Animated.Value(0), opacity: new Animated.Value(0), comet: new Animated.Value(0) }).current;
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
    const { filled, opacity, comet } = values;
    const plate = (extra: number) => ({ position: "absolute", left: 0, top: 0, bottom: 0, width: width + extra }) as const;
    return (
      <Animated.View
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width + plates.tail.extra, opacity, transform: [{ translateX: filled.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
          <GradientFill color={color} stops={plates.tail.stops} fade={plates.tail.fade} style={plate(plates.tail.extra)} />
          <GradientFill color={color} stops={plates.cap.stops} fade={plates.cap.fade} style={plate(plates.cap.extra)} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: comet }]}>
          <GradientFill color={color} stops={plates.comet.stops} fade={plates.comet.fade} style={plate(plates.comet.extra)} />
        </Animated.View>
      </Animated.View>
    );
  }, [width, height, color]);

  return (
    <View pointerEvents="none" onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]}>
      {layers}
    </View>
  );
});

export const FieldLoadFill = fieldGlowAvailable ? FieldGlowFill : JsFieldLoadFill;
