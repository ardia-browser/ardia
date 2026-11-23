import { useCallback, useRef, type Ref, type RefCallback } from "react";
import { processColor, StyleSheet, TurboModuleRegistry, type TurboModule, type View, type ViewProps } from "react-native";
import { backedStyles, nativePaint, processedColorDraws, type ColorDraws, type Flat } from "./backgroundFill";
import { RawView } from "./raw/rawView";

type NativeProps = { style?: unknown } & Record<string, unknown>;
type Routable = View & { setNativeProps(props: NativeProps): void };
type LaunchConfig = TurboModule & { launchConfig(): { test?: Record<string, string> } };

const useMergeRefs: <T>(...refs: (Ref<T> | undefined)[]) => RefCallback<T> = require("react-native/Libraries/Utilities/useMergeRefs").default;

let raw: boolean | null = null;

function drawsBackgroundsRaw(): boolean {
  if (raw !== null) return raw;
  try {
    raw = TurboModuleRegistry.get<LaunchConfig>("ArdiaApp")?.launchConfig().test?.rawBackgrounds === "1";
  } catch {
    raw = false;
  }
  return raw;
}

const draws: ColorDraws = (color) => color != null && color !== "transparent" && processedColorDraws(processColor(color as Parameters<typeof processColor>[0]));

const routed = new WeakSet<object>();

function routePaint(instance: Routable, fill: { current: View | null }) {
  if (routed.has(instance) || typeof instance.setNativeProps !== "function") return;
  routed.add(instance);
  const original = instance.setNativeProps;
  try {
    instance.setNativeProps = (props: NativeProps) => {
      const filled = fill.current as Routable | null;
      const paint = filled && props?.style != null ? nativePaint(StyleSheet.flatten(props.style as never) as Flat | undefined) : null;
      if (!filled || !paint) return original.call(instance, props);
      filled.setNativeProps({ style: paint.fill });
      return original.call(instance, { ...props, style: paint.own });
    };
  } catch {
    routed.delete(instance);
  }
}

export function BackedView({ ref, style, children, collapsable, ...rest }: ViewProps & { ref?: Ref<View> }) {
  const fill = useRef<View>(null);
  const route = useCallback((instance: View | null) => void (instance && routePaint(instance as Routable, fill)), []);
  const merged = useMergeRefs(route, ref);
  const backed = style == null || drawsBackgroundsRaw() ? null : backedStyles(StyleSheet.flatten(style) as Flat | undefined, draws);
  return (
    <RawView {...rest} ref={merged} collapsable={backed ? false : collapsable} style={backed ? backed.own : style}>
      {backed ? <RawView ref={fill} pointerEvents="none" style={backed.fill} /> : null}
      {children}
    </RawView>
  );
}

BackedView.displayName = "View";

export default BackedView;
