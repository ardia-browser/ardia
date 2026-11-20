import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const SHOW = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
const HIDE = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

export function useKeyboardHeight(listening = true): number {
  const [height, setHeight] = useState(Keyboard.metrics()?.height ?? 0);
  useEffect(() => {
    if (!listening) return;
    setHeight(Keyboard.metrics()?.height ?? 0);
    const show = Keyboard.addListener(SHOW, (event) => setHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener(HIDE, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [listening]);
  return height;
}

export const keyboardTopFromBottom = (keyboard: number, inset: number): number => (!keyboard ? 0 : Platform.OS === "android" ? keyboard + inset : Math.max(keyboard, inset));

export function useKeyboardTopFromBottom(listening = true): number {
  const keyboard = useKeyboardHeight(listening);
  return keyboardTopFromBottom(keyboard, useSafeAreaInsets().bottom);
}

export function useBottomLift(): { lift: number; keyboard: boolean } {
  const keyboard = useKeyboardHeight();
  const inset = useSafeAreaInsets().bottom;
  if (!keyboard) return { lift: inset, keyboard: false };
  return { lift: keyboardTopFromBottom(keyboard, inset), keyboard: true };
}
