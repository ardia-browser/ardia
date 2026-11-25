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

type NativeAccessibility = { handOverFocus?: (tag: number, within: boolean) => Promise<number | void>; focusView?: (tag: number) => Promise<number | void>; returnFocus?: (tag: number) => Promise<number | void>; cancelFocus?: (request: number) => Promise<void>; announce?: (text: string) => Promise<void> };

const native = requireOptionalNativeModule<NativeAccessibility>("ArdiaPhoneAccessibility");

const hasNative = native !== null;

export const screenReaderFocusIsNative = () => typeof native?.focusView === "function";

export function focusViewNatively(tag: number, { returning = false }: { returning?: boolean } = {}): () => void {
  let cancelled = false;
  let request: number | null = null;
  const revoke = (id: number) => void native?.cancelFocus?.(id).catch(() => undefined);
  const asked = returning && typeof native?.returnFocus === "function" ? native.returnFocus(tag) : native?.focusView?.(tag);
  void asked
    ?.then((answer) => {
      if (typeof answer !== "number") return;
      if (cancelled) revoke(answer);
      else request = answer;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    if (request !== null) revoke(request);
  };
}

export const screenReaderHandOverIsNative = () => typeof native?.handOverFocus === "function";

export function handOverFocusNatively(tag: number, within: boolean): () => void {
  let cancelled = false;
  let request: number | null = null;
  void native
    ?.handOverFocus?.(tag, within)
    .then((answer) => {
      if (typeof answer !== "number") return;
      if (cancelled) void native?.cancelFocus?.(answer).catch(() => undefined);
      else request = answer;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    if (request !== null) void native?.cancelFocus?.(request).catch(() => undefined);
  };
}

export function announceNatively(text: string) {
  void native?.announce?.(text).catch(() => undefined);
}

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneAccessibility", "ScrollActions"));

export function ScrollActions({ onScrollAction, canScrollForward, canScrollBackward, ...rest }: ScrollActionsProps) {
  if (!hasNative) return createElement(View, rest);
  return createElement(view(), { ...rest, canScrollForward, canScrollBackward, onScrollAction: (event) => onScrollAction(event.nativeEvent.direction) });
}
