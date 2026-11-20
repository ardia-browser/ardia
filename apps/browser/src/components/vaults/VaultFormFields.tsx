import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { Animated, TextInput, View } from "react-native";
import { space, Text, useTheme, withAlpha } from "../ui";
import { crossfade } from "../ui/motion";
import { font as typeScale, lineHeight } from "../ui/tokens";
import { VAULT_SIGN_IN } from "./tokens";

const FIELD_KEYS = [{ key: "Escape" }, { key: "Tab" }, { key: "Tab", shiftKey: true }];

export function FormRow({ label, error, focused, invalid, children }: { label: string; error?: string; focused?: boolean; invalid?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={ROW}>
      <View style={ROW_LINE}>
        <Text style={LABEL} tone={invalid ? "destructive" : "textPrimary"} lines={1}>
          {label}
        </Text>
        <View style={FIELD}>
          {focused ? <View pointerEvents="none" style={[FOCUS_RING, { borderColor: withAlpha(theme.formAccent, VAULT_SIGN_IN.ringAlpha) }]} /> : null}
          {children}
        </View>
      </View>
      {error ? <FieldError text={error} /> : null}
    </View>
  );
}

export function FieldError({ text, standalone }: { text: string; standalone?: boolean }) {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    appear.setValue(0);
    const run = Animated.timing(appear, { toValue: 1, ...crossfade, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [text]);
  return (
    <Animated.View accessibilityLiveRegion="polite" style={[standalone ? NOTE : ERROR_UNDER_FIELD, { opacity: appear }]}>
      <Text size="small" tone="destructive" style={ERROR_TEXT}>
        {text}
      </Text>
    </Animated.View>
  );
}

export function PlainField({
  value,
  onChangeText,
  placeholder,
  label,
  autoFocus,
  mono,
  inputRef,
  onSubmit,
  onEscape,
  onTab,
  onFocusChange,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  mono?: boolean;
  inputRef?: Ref<TextInput>;
  onSubmit: () => void;
  onEscape: () => void;
  onTab: (back: boolean) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.placeholder}
      selectionColor={theme.selection}
      enableFocusRing={false}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      autoFocus={autoFocus}
      autoCorrect={false}
      spellCheck={false}
      accessibilityLabel={label}
      onSubmitEditing={onSubmit}
      keyDownEvents={FIELD_KEYS}
      onKeyDown={(e) => {
        const { key, shiftKey } = e.nativeEvent;
        if (key === "Escape") onEscape();
        else if (key === "Tab") onTab(!!shiftKey);
      }}
      style={[INPUT, { color: theme.textPrimary }, mono && MONO]}
    />
  );
}

export function SecretPlaceholder({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={SECRET_PLACEHOLDER}>
      <Text style={{ color: theme.placeholder }}>{text}</Text>
    </View>
  );
}

export const LABEL_WIDTH = 116;
export const ROW = { paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 40, justifyContent: "center" } as const;
export const ROW_LINE = { flexDirection: "row", alignItems: "center", gap: space.l } as const;
const LABEL = { width: LABEL_WIDTH } as const;
export const FIELD = { flex: 1, minWidth: 0 } as const;
const INPUT = { ...typeScale.body, width: "100%", paddingVertical: 0 } as const;
const MONO = { fontFamily: "Menlo" } as const;
const ERROR_UNDER_FIELD = { marginTop: space.xs, marginLeft: LABEL_WIDTH + space.l } as const;
const NOTE = { marginTop: space.ml, paddingHorizontal: space.l } as const;
const ERROR_TEXT = { lineHeight: lineHeight.small } as const;
const SECRET_PLACEHOLDER = { position: "absolute", left: VAULT_SIGN_IN.secretInset, top: 0, bottom: 0, justifyContent: "center" } as const;
export const FOCUS_RING = {
  position: "absolute",
  left: -VAULT_SIGN_IN.ringOutsetX,
  right: 0,
  top: -VAULT_SIGN_IN.ringOutsetY,
  bottom: -VAULT_SIGN_IN.ringOutsetY,
  borderRadius: VAULT_SIGN_IN.ringRadius,
  borderWidth: VAULT_SIGN_IN.ringWidth,
} as const;
