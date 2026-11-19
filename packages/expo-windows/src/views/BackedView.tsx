import { forwardRef } from "react";
import type { AppNative } from "@ardia/shell";
import { StyleSheet, View, type ViewProps } from "react-native";
import { backgroundFill, type Flat } from "./backgroundFill";
import { requireNativeModule } from "../modules";

let raw: boolean | null = null;

function drawsBackgroundsRaw(): boolean {
  if (raw !== null) return raw;
  try {
    raw = requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test.rawBackgrounds === "1";
  } catch {
    raw = false;
  }
  return raw;
}

export const BackedView = forwardRef<View, ViewProps>(function BackedView({ style, children, ...rest }, ref) {
  const flat = (StyleSheet.flatten(style) ?? {}) as Flat;
  const fill = drawsBackgroundsRaw() ? null : backgroundFill(flat);
  const { backgroundColor: _drawnByTheFill, ...own } = flat;
  return (
    <View {...rest} ref={ref} style={fill ? own : style}>
      {fill ? <View pointerEvents="none" style={fill} /> : null}
      {children}
    </View>
  );
});
