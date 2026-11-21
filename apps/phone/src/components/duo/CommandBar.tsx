import { useWindowDimensions, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScreenLayout } from "../../state/app/screenLayout";
import { floatingPanelLayout } from "../ui";
import { commandBarKeyboardTop, commandBarPlacement, commandBarRise, type CommandBarPlacement } from "./duoLayout";

export { commandBarRise, type CommandBarPlacement };

export function useCommandBar(lift: number): CommandBarPlacement | null {
  const wide = useScreenLayout((s) => s.layout.name === "wide");
  const screen = useWindowDimensions();
  const canvas = useScreenLayout((s) => s.canvas);
  const window = canvas ?? screen;
  const insets = useSafeAreaInsets();
  if (!wide) return null;
  return commandBarPlacement(window.width, insets, commandBarKeyboardTop(window.height, lift));
}

export const commandPanelPlace = (placement: CommandBarPlacement): ViewStyle => ({
  position: "absolute",
  top: placement.top,
  left: placement.left,
  width: placement.width,
  height: placement.maxHeight,
  borderRadius: floatingPanelLayout.radius,
  borderCurve: "continuous",
  transformOrigin: "top",
});

export function commandBarMotion(rise: number, dim: number, reduceMotion: boolean, drag: number, back: number) {
  "worklet";
  const shown = commandBarRise(reduceMotion ? dim : rise, reduceMotion);
  return { opacity: shown.opacity, transform: [{ translateY: drag + back }, { scale: shown.scale }] };
}
