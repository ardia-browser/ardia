import { createElement, type ComponentType, type ReactNode } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";

export type ScrollActionDirection = "forward" | "backward";

export type ScrollActionsProps = ViewProps & {
  canScrollForward: boolean;
  canScrollBackward: boolean;
  onScrollAction: (direction: ScrollActionDirection) => void;
  children?: ReactNode;
};

type NativeProps = Omit<ScrollActionsProps, "onScrollAction"> & {
  onScrollAction: (event: NativeSyntheticEvent<{ direction: ScrollActionDirection }>) => void;
};

const hasNative = requireOptionalNativeModule("ArdiaPhoneAccessibility") !== null;

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneAccessibility", "ScrollActions"));

export function ScrollActions({ onScrollAction, canScrollForward, canScrollBackward, ...rest }: ScrollActionsProps) {
  if (!hasNative) return createElement(View, rest);
  return createElement(view(), { ...rest, canScrollForward, canScrollBackward, onScrollAction: (event) => onScrollAction(event.nativeEvent.direction) });
}
