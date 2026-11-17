import { createElement, type ComponentType } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { StyleSheet, type ViewProps } from "react-native";

export type ScreenLayoutName = "phone" | "column" | "wide" | "split";

export type ScreenLayoutEdge = "leading" | "trailing";

export type DuoCanvasMode = "wide" | "split" | "column";

export type ScreenSpaceReport = {
  width: number;
  height: number;
  safeTop: number;
  safeLeading: number;
  safeBottom: number;
  safeTrailing: number;
  hinge: "none" | "closed" | "partiallyOpen" | "fullyOpen";
  verticalBarEdge: ScreenLayoutEdge | null;
  divisions: { x: number; y: number; width: number; height: number }[];
};

export type ScreenLayoutReport = {
  layout: ScreenLayoutName;
  space: ScreenSpaceReport;
  forced: DuoCanvasMode | null;
  column?: { edge: ScreenLayoutEdge; inset: number };
  fold?: { top: number; bottom: number };
  canvas?: { width: number; height: number };
};

type ScreenLayoutNative = { forcedCanvas?: () => DuoCanvasMode | null };

const native = requireOptionalNativeModule<ScreenLayoutNative>("ArdiaPhoneScreenLayout");

let probe: ComponentType<ViewProps & { onLayoutChange: (event: { nativeEvent: ScreenLayoutReport }) => void }> | null = null;

export const screenLayoutIsNative = () => native != null;

export const forcedDuoCanvas = (): DuoCanvasMode | null => native?.forcedCanvas?.() ?? null;

export function ScreenLayoutProbe({ onLayoutChange }: { onLayoutChange: (report: ScreenLayoutReport) => void }) {
  if (!native) return null;
  probe ??= requireNativeViewManager("ArdiaPhoneScreenLayout");
  return createElement(probe, { pointerEvents: "none", style: StyleSheet.absoluteFill, onLayoutChange: (event: { nativeEvent: ScreenLayoutReport }) => onLayoutChange(event.nativeEvent) });
}
