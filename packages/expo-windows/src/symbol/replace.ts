import { AccessibilityInfo, Animated, Easing } from "react-native";

export const SYMBOL_REPLACE = {
  out: { duration: 160, scale: 0.5 },
  in: { scale: 0.5, fadeBy: 0.4, stiffness: 380, damping: 26 },
  fade: 150,
} as const;

const STRONG_OUT = Easing.bezier(0.23, 1, 0.32, 1);

let reduceMotion = false;
let watching = false;

function watchReduceMotion() {
  if (watching) return;
  watching = true;
  try {
    AccessibilityInfo.isReduceMotionEnabled().then(
      (on) => void (reduceMotion = on),
      () => {},
    );
    AccessibilityInfo.addEventListener("reduceMotionChanged", (on) => void (reduceMotion = on));
  } catch {
    reduceMotion = false;
  }
}

export function replaceStyles(incoming: Animated.Value, outgoing: Animated.Value, calm: boolean) {
  const R = SYMBOL_REPLACE;
  return {
    incoming: {
      opacity: incoming.interpolate({ inputRange: [0, calm ? 1 : R.in.fadeBy], outputRange: [0, 1], extrapolate: "clamp" as const }),
      transform: calm ? [] : [{ scale: incoming.interpolate({ inputRange: [0, 1], outputRange: [R.in.scale, 1] }) }],
    },
    outgoing: {
      opacity: outgoing.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
      transform: calm ? [] : [{ scale: outgoing.interpolate({ inputRange: [0, 1], outputRange: [1, R.out.scale] }) }],
    },
  };
}

export function playReplace(incoming: Animated.Value, outgoing: Animated.Value, done: () => void): boolean {
  watchReduceMotion();
  const calm = reduceMotion;
  const R = SYMBOL_REPLACE;
  incoming.setValue(0);
  outgoing.setValue(0);
  const fadeOut = Animated.timing(outgoing, { toValue: 1, duration: calm ? R.fade : R.out.duration, easing: STRONG_OUT, useNativeDriver: true });
  const fadeIn = calm
    ? Animated.timing(incoming, { toValue: 1, duration: R.fade, easing: STRONG_OUT, useNativeDriver: true })
    : Animated.spring(incoming, { toValue: 1, stiffness: R.in.stiffness, damping: R.in.damping, mass: 1, useNativeDriver: true });
  Animated.parallel([fadeOut, fadeIn]).start(({ finished }) => finished && done());
  return calm;
}
