import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type Ref } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { Platform, Pressable, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputInstance, type ViewProps } from "react-native";
import type { CompletionOffer } from "./completingField";
import type { MaterialRole } from "./material";
import { labLog } from "./system";

export type MaterialSearchBarHandle = {
  focus(): void;
  blur(): void;
  setText(text: string, selectsAll?: boolean): void;
};

export type MaterialSearchAppearance = { dark?: boolean; scheme?: Partial<Record<MaterialRole, string>> };

export type MaterialSearchBarProps = ViewProps & {
  text: string;
  offer?: CompletionOffer | null;
  selectsAllOnFocus?: boolean;
  placeholder?: string;
  fieldLabel?: string;
  incognito?: boolean;
  showsVoice?: boolean;
  fieldOnly?: boolean;
  embedded?: boolean;
  appearance?: MaterialSearchAppearance;
  onTypedChange?: (typed: string) => void;
  onSubmit?: (displayed: string) => void;
  onFocusChange?: (focused: boolean) => void;
  onSuffixChange?: (suffix: string) => void;
  onClearPress?: () => void;
  onVoicePress?: () => void;
  onIncognitoPress?: () => void;
};

type NativeProps = Omit<
  MaterialSearchBarProps,
  "onTypedChange" | "onSubmit" | "onFocusChange" | "onSuffixChange" | "onClearPress" | "onVoicePress" | "onIncognitoPress"
> & {
  ref?: Ref<MaterialSearchBarHandle>;
  textEventCount: number;
  onTypedChange?: (event: NativeSyntheticEvent<{ typed: string; eventCount: number }>) => void;
  onSubmit?: (event: NativeSyntheticEvent<{ displayed: string; submit?: number }>) => void;
  onFocusChange?: (event: NativeSyntheticEvent<{ focused: boolean }>) => void;
  onSuffixChange?: (event: NativeSyntheticEvent<{ suffix: string }>) => void;
  onClearPress?: () => void;
  onVoicePress?: () => void;
  onIncognitoPress?: () => void;
};

const hasNative = Platform.OS === "android" && requireOptionalNativeModule("ArdiaPhoneMaterial") !== null;

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneMaterial"));

export const materialSearchBarIsNative = () => hasNative;

const borderlessRipple = { borderless: true, radius: 20 };

export const MaterialSearchBar = forwardRef<MaterialSearchBarHandle, MaterialSearchBarProps>(function MaterialSearchBar(props, ref) {
  const {
    text,
    offer,
    selectsAllOnFocus,
    placeholder = "Search…",
    fieldLabel = "Search or Enter Address",
    incognito = false,
    showsVoice = false,
    fieldOnly = false,
    embedded = false,
    appearance,
    style,
    onTypedChange,
    onSubmit,
    onFocusChange,
    onSuffixChange,
    onClearPress,
    onVoicePress,
    onIncognitoPress,
    ...rest
  } = props;
  const native = useRef<MaterialSearchBarHandle>(null);
  const eventCount = useRef(0);
  const input = useRef<TextInputInstance>(null);
  const [fallbackText, setFallbackText] = useState(text);
  useEffect(() => {
    setFallbackText(text);
  }, [text]);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => (hasNative ? native.current?.focus() : input.current?.focus()),
      blur: () => (hasNative ? native.current?.blur() : input.current?.blur()),
      setText: (next, selectsAll = false) => {
        if (hasNative) native.current?.setText(next, selectsAll);
        else {
          setFallbackText(next);
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
      ref: native,
      style,
      text,
      textEventCount: eventCount.current,
      offer: offer ?? null,
      selectsAllOnFocus,
      placeholder,
      fieldLabel,
      incognito,
      showsVoice,
      fieldOnly,
      embedded,
      appearance,
      onTypedChange: (event) => {
        eventCount.current = event.nativeEvent.eventCount;
        onTypedChange?.(event.nativeEvent.typed);
      },
      onSubmit: (event) => {
        if (Platform.OS === "android") labLog(`PAGELAB material search js received submit #${event.nativeEvent.submit ?? "?"}`);
        onSubmit?.(event.nativeEvent.displayed);
      },
      onFocusChange: (event) => onFocusChange?.(event.nativeEvent.focused),
      onSuffixChange: (event) => onSuffixChange?.(event.nativeEvent.suffix),
      onClearPress: onClearPress ? () => onClearPress() : undefined,
      onVoicePress: onVoicePress ? () => onVoicePress() : undefined,
      onIncognitoPress: onIncognitoPress ? () => onIncognitoPress() : undefined,
    });
  }
  const scheme = appearance?.scheme;
  const boxFill = embedded ? undefined : scheme?.surfaceContainer;
  const ink = scheme?.onSurface;
  const hint = scheme?.onSurfaceVariant;
  const accent = scheme?.primary;
  return (
    <View {...rest} style={[styles.bar, fieldOnly ? styles.fieldOnly : null, style]}>
      <View testID="materialSearchBox" style={[styles.box, boxFill ? { backgroundColor: boxFill } : null]}>
        <TextInput
          ref={input}
          accessibilityLabel={fieldLabel}
          placeholder={placeholder}
          placeholderTextColor={hint}
          selectionColor={accent}
          cursorColor={accent}
          value={fallbackText}
          selectTextOnFocus={selectsAllOnFocus}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="web-search"
          returnKeyType={fieldOnly ? "search" : "go"}
          submitBehavior={fieldOnly ? "submit" : undefined}
          onChangeText={(next) => {
            setFallbackText(next);
            onTypedChange?.(next);
          }}
          onSubmitEditing={(event) => onSubmit?.(event.nativeEvent.text)}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          style={[styles.input, ink ? { color: ink } : null]}
        />
        {fallbackText.length > 0 ? (
          <Pressable
            testID="materialSearchClear"
            accessibilityRole="button"
            accessibilityLabel="Clear Text"
            hitSlop={4}
            android_ripple={borderlessRipple}
            onPress={() => {
              setFallbackText("");
              onTypedChange?.("");
              onClearPress?.();
            }}
            style={styles.fieldAction}
          />
        ) : !incognito && showsVoice ? (
          <Pressable testID="materialSearchVoice" accessibilityRole="button" accessibilityLabel="Voice Search" hitSlop={4} android_ripple={borderlessRipple} onPress={onVoicePress} style={styles.fieldAction} />
        ) : null}
        {!fieldOnly ? <Pressable
          testID="materialSearchIncognito"
          accessibilityRole="button"
          accessibilityLabel={incognito ? "Deactivate Incognito" : "Activate Incognito"}
          accessibilityState={{ selected: incognito }}
          android_ripple={borderlessRipple}
          onPress={onIncognitoPress}
          style={[styles.iconButton, incognito && scheme?.primaryContainer ? { backgroundColor: scheme.primaryContainer } : null]}
        /> : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", height: 48 },
  fieldOnly: { height: 48, paddingHorizontal: 0, elevation: 0 },
  box: { flex: 1, height: 48, borderRadius: 9999, flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 4, gap: 8, overflow: "hidden" },
  input: { flex: 1, height: 48, paddingVertical: 0 },
  iconButton: { width: 48, height: 48, borderRadius: 9999, alignItems: "center", justifyContent: "center" },
  fieldAction: { width: 40, height: 40, borderRadius: 9999, alignItems: "center", justifyContent: "center" },
});
