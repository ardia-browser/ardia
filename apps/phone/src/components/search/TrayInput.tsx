import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Platform, TextInput, type StyleProp, type TextStyle, type TextInputInstance } from "react-native";
import { withAlpha } from "../../lib/color";
import { inlineOffer } from "../../lib/inlineOffer";
import { CompletingField, completingFieldIsNative, type CompletingFieldHandle } from "../../platform/completingField";
import { useSearchCompletedFor, useSearchCompletion } from "../../state/search/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { font } from "../ui";
import { searchPanel } from "./searchPanelTokens";

export type TrayInputHandle = { focus(): void; blur(): void; clearsInPlace(): boolean };

type Props = {
  start: string;
  selectsStart: boolean;
  color: string;
  placeholderColor: string;
  accent: string;
  keyboardAppearance: "default" | "dark";
  holdsScroll?: boolean;
  nativeID?: string;
  onTyped: (text: string) => void;
  onSubmit: (text: string) => void;
  style: StyleProp<TextStyle>;
  weight?: "regular" | "medium";
};

const SHARED = {
  placeholder: "Search…",
  accessibilityLabel: "Search or Enter Address",
  autoCapitalize: "none",
  autoCorrect: false,
  keyboardType: "web-search",
  returnKeyType: "go",
} as const;

export const TrayInput = forwardRef<TrayInputHandle, Props>(function TrayInput(props, ref) {
  return completingFieldIsNative() ? <CompletingInput {...props} ref={ref} /> : <PlainInput {...props} ref={ref} />;
});

const CompletingInput = forwardRef<TrayInputHandle, Props>(function CompletingInput({ start, selectsStart, color, placeholderColor, accent, keyboardAppearance, holdsScroll, nativeID, onTyped, onSubmit, style, weight = "regular" }, ref) {
  const field = useRef<CompletingFieldHandle>(null);
  const [typed, setTyped] = useState(start);
  const completion = useSearchCompletion();
  const completedFor = useSearchCompletedFor();
  const typedNow = useRef(onTyped);
  typedNow.current = onTyped;
  useImperativeHandle(
    ref,
    () => ({
      focus: () => field.current?.focus(),
      blur: () => field.current?.blur(),
      clearsInPlace: () => {
        if (Platform.OS !== "ios") return false;
        field.current?.setText("", false);
        setTyped("");
        typedNow.current("");
        return true;
      },
    }),
    [],
  );
  useEffect(() => {
    if (selectsStart && start) field.current?.setText(start, true);
  }, []);
  return (
    <CompletingField
      ref={field}
      {...SHARED}
      style={style}
      text={typed}
      offer={inlineOffer(completion, completedFor)}
      highlightColor={withAlpha(accent, 0.3)}
      keyboardAppearance={keyboardAppearance}
      holdsScroll={holdsScroll}
      nativeID={nativeID}
      selectsAllOnFocus={selectsStart && start.length > 0}
      cursorColor={accent}
      selectionColor={withAlpha(accent, 0.3)}
      color={color}
      placeholderTextColor={placeholderColor}
      fontSize={font.title3.fontSize}
      fontWeight={weight}
      onTypedChange={(next) => {
        setTyped(next);
        onTyped(next);
      }}
      onSubmit={onSubmit}
      onFieldScroll={countFieldScroll}
    />
  );
});

const countFieldScroll = () => {
  if (!useTabs.getState().incognito) countUsage("address_field_scrolled");
};

const PlainInput = forwardRef<TrayInputHandle, Props>(function PlainInput({ start, selectsStart, color, placeholderColor, accent, keyboardAppearance, onTyped, onSubmit, style, weight = "regular" }, ref) {
  const input = useRef<TextInputInstance>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(
    selectsStart && start ? { start: 0, end: start.length } : { start: start.length, end: start.length },
  );
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), blur: () => input.current?.blur(), clearsInPlace: () => false }), []);
  return (
    <TextInput
      ref={input}
      {...SHARED}
      style={[font.title3, style, { color }, weight === "medium" ? MEDIUM : null]}
      defaultValue={start}
      selection={selection}
      onSelectionChange={() => {
        if (selection) setSelection(undefined);
      }}
      onChangeText={onTyped}
      onSubmitEditing={(event) => onSubmit(event.nativeEvent.text)}
      placeholderTextColor={placeholderColor}
      selectionColor={accent}
      keyboardAppearance={keyboardAppearance}
      maxFontSizeMultiplier={searchPanel.maxTextScale}
      submitBehavior="submit"
      disableFullscreenUI
    />
  );
});

const MEDIUM = { fontWeight: "500" } as const;
