import { forwardRef, useEffect, useMemo, useRef } from "react";
import { Animated, type View } from "react-native";
import type { BreatheProps } from "@ardia/shell";

const raisedCosine = (t: number) => (1 - Math.cos(2 * Math.PI * t)) / 2;

export const Breathe = forwardRef<View, Partial<BreatheProps>>(function Breathe({ running = false, cycleMs = 1420, opacityRange, scaleRange, style, children, ...rest }, ref) {
  const level = useRef(new Animated.Value(0)).current;
  const ms = cycleMs > 0 ? cycleMs : 1420;
  const [lowOpacity, highOpacity] = opacityRange ?? [1, 1];
  const [lowScale, highScale] = scaleRange ?? [1, 1];
  useEffect(() => {
    if (!running) return;
    level.setValue(0);
    const loop = Animated.loop(Animated.timing(level, { toValue: 1, duration: ms, easing: raisedCosine, useNativeDriver: true, isInteraction: false }));
    loop.start();
    return () => {
      loop.stop();
      level.stopAnimation();
      level.setValue(0);
    };
  }, [level, ms, running]);
  const motion = useMemo(
    () => ({
      opacity: level.interpolate({ inputRange: [0, 1], outputRange: [lowOpacity, highOpacity] }),
      transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [lowScale, highScale] }) }],
    }),
    [highOpacity, highScale, level, lowOpacity, lowScale],
  );
  return (
    <Animated.View {...rest} ref={ref} pointerEvents="none" style={[style, motion]}>
      {children}
    </Animated.View>
  );
});
