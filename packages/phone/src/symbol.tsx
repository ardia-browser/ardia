import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType } from "react";
import type { ViewProps } from "react-native";

export type NativeSymbolWeight = "ultralight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold" | "heavy";

export type NativeSymbolProps = ViewProps & {
  name: string;
  pointSize: number;
  weight?: NativeSymbolWeight;
  color?: string;
};

const symbolModule = requireOptionalNativeModule<{ exists(name: string): boolean }>("ArdiaPhoneSymbol");

let nativeView: ComponentType<NativeSymbolProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeSymbolProps>("ArdiaPhoneSymbol"));

export const nativeSymbolsAvailable = () => symbolModule !== null;

export const nativeSymbolExists = (name: string) => symbolModule?.exists(name) ?? false;

export function NativeSymbol(props: NativeSymbolProps) {
  if (!symbolModule) return null;
  return createElement(view(), props);
}
