import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { KeyboardState, runOnJS, useAnimatedKeyboard, useAnimatedReaction, useSharedValue, type SharedValue } from "react-native-reanimated";
import { keyboardIsUp, TRAY_LIFT } from "../../lib/trayMotion";
import { keyboardTargets } from "../../platform/keyboard";

let knownFull = 0;

export type TrayKeyboard = { height: SharedValue<number>; full: SharedValue<number>; target: number };

export function useTrayKeyboard(): TrayKeyboard {
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  const full = useSharedValue(knownFull);
  const [target, setTarget] = useState(() => (Keyboard.isVisible() ? knownFull : 0));
  const remember = (height: number) => {
    if (height <= TRAY_LIFT.keyboardThreshold) return;
    knownFull = height;
    full.value = height;
  };
  useEffect(() => {
    if (Platform.OS === "android" && keyboardTargets.isAvailable()) {
      const now = keyboardTargets.current();
      if (now && now.height > TRAY_LIFT.keyboardThreshold) remember(now.height);
      const willChange = keyboardTargets.addWillChangeListener((change) => {
        remember(change.target);
        setTarget(change.target > TRAY_LIFT.keyboardThreshold ? change.target : 0);
      });
      const didChange = keyboardTargets.addDidChangeListener((change) => {
        remember(change.height);
        setTarget(change.height > TRAY_LIFT.keyboardThreshold ? change.height : 0);
      });
      return () => {
        willChange.remove();
        didChange.remove();
      };
    }
    const shows = Platform.OS === "ios" ? ["keyboardWillShow", "keyboardWillChangeFrame"] : ["keyboardDidShow"];
    const hides = Platform.OS === "ios" ? ["keyboardWillHide"] : ["keyboardDidHide"];
    const subscriptions = [
      ...shows.map((name) =>
        Keyboard.addListener(name as "keyboardWillShow", (event) => {
          remember(event.endCoordinates.height);
          setTarget(event.endCoordinates.height);
        }),
      ),
      ...hides.map((name) => Keyboard.addListener(name as "keyboardWillHide", () => setTarget(0))),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  useAnimatedReaction(
    () => keyboard.state.value,
    (state, previous) => {
      if (state === previous) return;
      if (state === KeyboardState.OPEN && keyboardIsUp(keyboard.height.value)) {
        full.value = keyboard.height.value;
        runOnJS(remember)(keyboard.height.value);
        runOnJS(setTarget)(keyboard.height.value);
      } else if (state === KeyboardState.OPENING && full.value > 0) runOnJS(setTarget)(full.value);
      else if (state === KeyboardState.CLOSING) runOnJS(setTarget)(0);
    },
  );
  return { height: keyboard.height, full, target };
}
