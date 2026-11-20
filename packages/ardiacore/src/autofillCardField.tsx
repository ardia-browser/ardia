import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type { CardNumberSummary } from "./autofill";

export type CardNumberFieldProps = ViewProps & {
  entry: string;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  onEdit?: (summary: CardNumberSummary) => void;
  onSubmit?: () => void;
  onEscape?: () => void;
  onTab?: (back: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
};

export type CardNumberFieldHandle = { focus: () => void };

type NativeProps = Omit<CardNumberFieldProps, "onEdit" | "onTab" | "onFocusChange"> & {
  onEdit?: (e: NativeSyntheticEvent<CardNumberSummary>) => void;
  onTab?: (e: NativeSyntheticEvent<{ back: boolean }>) => void;
  onFocusChange?: (e: NativeSyntheticEvent<{ focused: boolean }>) => void;
};

type NativeHandle = { focus?: () => Promise<void> };
type NativeView = React.ComponentType<NativeProps & { ref?: React.Ref<NativeHandle> }>;
let Native: NativeView | undefined;
const native = (): NativeView => (Native ??= requireNativeViewManager<NativeProps>("ArdiaAutofillCardField") as unknown as NativeView);

export const CardNumberField = forwardRef<CardNumberFieldHandle, CardNumberFieldProps>(function CardNumberField({ onEdit, onTab, onFocusChange, ...props }, ref) {
  const View = native();
  const view = useRef<NativeHandle>(null);
  useImperativeHandle(ref, () => ({ focus: () => void view.current?.focus?.() }), []);
  return (
    <View
      {...props}
      ref={view}
      onEdit={onEdit ? (e) => onEdit(e.nativeEvent) : undefined}
      onTab={onTab ? (e) => onTab(e.nativeEvent.back) : undefined}
      onFocusChange={onFocusChange ? (e) => onFocusChange(e.nativeEvent.focused) : undefined}
    />
  );
});
