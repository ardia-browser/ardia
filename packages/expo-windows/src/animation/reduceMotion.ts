import { AccessibilityInfo } from "react-native";

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

export function animationEffectsOff(): boolean {
  watchReduceMotion();
  return reduceMotion;
}
