import { AccessibilityInfo, Animated, Easing } from "react-native";

export const SYMBOL_BOUNCE = {
  duration: 560,
  scales: [1, 0.8, 1.1, 0.99, 1],
  offsets: [0, 0.25, 0.53, 0.78, 1],
} as const;

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

export function bounceScale(progress: Animated.Value) {
  return progress.interpolate({ inputRange: [...SYMBOL_BOUNCE.offsets], outputRange: [...SYMBOL_BOUNCE.scales] });
}

export function playBounce(progress: Animated.Value) {
  watchReduceMotion();
  if (reduceMotion) return;
  progress.setValue(0);
  Animated.timing(progress, { toValue: 1, duration: SYMBOL_BOUNCE.duration, easing: Easing.linear, useNativeDriver: true }).start();
}
