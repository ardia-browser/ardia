import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType } from "react";
import { View, type ViewProps } from "react-native";
import { nativeFadeProps, type FadeEdge, type FadeEdges } from "./fadeProps";

export type { FadeEdge } from "./fadeProps";

export type FadeViewProps = ViewProps & FadeEdges;

const hasNative = requireOptionalNativeModule("ArdiaPhoneFade") !== null;

type NativeFadeProps = ViewProps & Partial<Record<"topFade" | "bottomFade" | "leadingFade" | "trailingFade", FadeEdge>>;

let nativeView: ComponentType<NativeFadeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeFadeProps>("ArdiaPhoneFade"));

export const fadeIsNative = () => hasNative;

export function FadeView(props: FadeViewProps) {
  const { top, bottom, leading, trailing, ...rest } = props;
  if (!hasNative) return createElement(View, rest);
  return createElement(view(), { ...rest, ...nativeFadeProps({ top, bottom, leading, trailing }) } as NativeFadeProps);
}
