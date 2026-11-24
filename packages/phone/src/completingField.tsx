import { createElement, forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { labLog } from "./system";
import { Platform, processColor, TextInput, type ColorValue, type NativeSyntheticEvent, type TextInputProps, type ViewProps, type TextInputInstance } from "react-native";

export type CompletionOffer = { query: string; completion: string };

export type CompletingFieldHandle = {
  focus(): void;
  blur(): void;
  setText(text: string, selectsAll?: boolean): void;
};

type SharedInputProps = Pick<
  TextInputProps,
  | "placeholder"
  | "placeholderTextColor"
  | "cursorColor"
  | "selectionColor"
  | "keyboardType"
  | "keyboardAppearance"
  | "returnKeyType"
  | "autoCapitalize"
  | "autoCorrect"
  | "autoFocus"
  | "editable"
  | "maxLength"
  | "accessibilityLabel"
>;

export type CompletingFieldProps = ViewProps &
  SharedInputProps & {
    text: string;
    offer?: CompletionOffer | null;
    highlightColor?: string;
    selectsAllOnFocus?: boolean;
    holdsScroll?: boolean;
    color?: string;
    fontSize?: number;
    fontWeight?: "regular" | "medium" | "semibold" | "bold";
    onTypedChange?: (typed: string) => void;
    onSubmit?: (displayed: string) => void;
    onFocusChange?: (focused: boolean) => void;
    onSuffixChange?: (suffix: string) => void;
    onFieldScroll?: () => void;
  };

export type NativeColor = ColorValue | number;

type NativeProps = Omit<
  CompletingFieldProps,
  "onTypedChange" | "onSubmit" | "onFocusChange" | "onSuffixChange" | "onFieldScroll" | "accessibilityLabel" | "highlightColor" | "color" | "placeholderTextColor" | "cursorColor" | "selectionColor"
> & {
  cursorColor?: NativeColor;
  selectionColor?: NativeColor;
  ref?: Ref<CompletingFieldHandle>;
  highlightColor?: NativeColor;
  color?: NativeColor;
  placeholderTextColor?: NativeColor;
  textEventCount: number;
  fieldLabel?: string;
  onTypedChange?: (event: NativeSyntheticEvent<{ typed: string; eventCount: number }>) => void;
  onSubmit?: (event: NativeSyntheticEvent<{ displayed: string; submit?: number }>) => void;
  onFocusChange?: (event: NativeSyntheticEvent<{ focused: boolean }>) => void;
  onSuffixChange?: (event: NativeSyntheticEvent<{ suffix: string }>) => void;
  onFieldScroll?: () => void;
};

const hasNative = requireOptionalNativeModule("ArdiaPhoneCompletingField") !== null;

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneCompletingField"));

export const completingFieldIsNative = () => hasNative;

export function nativeFieldColor(value: ColorValue | undefined): NativeColor | undefined {
  if (value == null || Platform.OS !== "android") return value ?? undefined;
  const processed = processColor(value);
  return typeof processed === "number" ? processed : undefined;
}

const fallbackWeights = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

export const CompletingField = forwardRef<CompletingFieldHandle, CompletingFieldProps>(function CompletingField(props, ref) {
  const { onTypedChange, onSubmit, onFocusChange, onSuffixChange, onFieldScroll, text, offer, highlightColor, selectsAllOnFocus, holdsScroll, color, fontSize, fontWeight, style, accessibilityLabel, ...rest } = props;
  const native = useRef<CompletingFieldHandle>(null);
  const eventCount = useRef(0);
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => (hasNative ? native.current?.focus() : input.current?.focus()),
      blur: () => (hasNative ? native.current?.blur() : input.current?.blur()),
      setText: (next, selectsAll = false) => {
        if (hasNative) native.current?.setText(next, selectsAll);
        else {
          onTypedChange?.(next);
          if (selectsAll) input.current?.setSelection(0, next.length);
        }
      },
    }),
    [onTypedChange],
  );
  if (hasNative) {
    return createElement(view(), {
      ...rest,
      placeholderTextColor: nativeFieldColor(rest.placeholderTextColor),
      cursorColor: nativeFieldColor(rest.cursorColor ?? undefined),
      selectionColor: nativeFieldColor(rest.selectionColor),
      ref: native,
      style,
      text,
      textEventCount: eventCount.current,
      fieldLabel: accessibilityLabel,
      offer: offer ?? null,
      highlightColor: nativeFieldColor(highlightColor),
      selectsAllOnFocus,
      holdsScroll: Platform.OS === "ios" ? holdsScroll : undefined,
      color: nativeFieldColor(color),
      fontSize,
      fontWeight,
      onTypedChange: (event) => {
        eventCount.current = event.nativeEvent.eventCount;
        onTypedChange?.(event.nativeEvent.typed);
      },
      onSubmit: (event) => {
        if (Platform.OS === "android") labLog(`PAGELAB completion js received submit #${event.nativeEvent.submit ?? "?"} "${event.nativeEvent.displayed}"`);
        onSubmit?.(event.nativeEvent.displayed);
      },
      onFocusChange: (event) => onFocusChange?.(event.nativeEvent.focused),
      onSuffixChange: (event) => onSuffixChange?.(event.nativeEvent.suffix),
      onFieldScroll: Platform.OS === "ios" && onFieldScroll ? () => onFieldScroll() : undefined,
    });
  }
  return createElement(TextInput, {
    ...rest,
    accessibilityLabel,
    ref: input,
    value: text,
    selectTextOnFocus: selectsAllOnFocus,
    style: [style, { color, fontSize, fontWeight: fontWeight ? fallbackWeights[fontWeight] : undefined }],
    onChangeText: (typed: string) => onTypedChange?.(typed),
    onSubmitEditing: () => onSubmit?.(text),
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
  });
});
