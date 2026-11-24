import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export type PasteButtonProps = ViewProps & {
  onPaste: (text: string) => void;
  tint?: string;
  display?: "iconAndLabel" | "labelOnly" | "iconOnly";
};

type NativeProps = Omit<PasteButtonProps, "onPaste"> & { onPaste: (event: NativeSyntheticEvent<{ text: string }>) => void };

const hasNative = requireOptionalNativeModule("ArdiaPhonePasteButton") !== null;

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhonePasteButton"));

export const pasteButtonIsNative = () => hasNative;

export function PasteButton({ onPaste, ...rest }: PasteButtonProps) {
  if (!hasNative) return null;
  return createElement(view(), { ...rest, onPaste: (event: NativeSyntheticEvent<{ text: string }>) => onPaste(event.nativeEvent.text) });
}
