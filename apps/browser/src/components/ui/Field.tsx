import { OutsidePressArea, showMenu, type MenuItem } from "@ardia/shell";
import { tapActivates } from "./a11y";
import { withIconNames } from "../../lib/activeLook";
import { POP_UP_CHROME } from "../../lib/platformChrome";
import { Symbol } from "./Symbol";
import { type Ref } from "react";
import { Animated, Pressable, StyleSheet, Text, TextInput, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { buttonMotion, usePressScaleMotion } from "./motion";
import { useTheme } from "./theme";
import { monoFace, opacity, perLook, proseLineHeight, radius, space, font as typeScale } from "./tokens";
import { useHover } from "./useHover";
import { useNativeForm } from "./nativeForm";
import { useKeyDownEvents, type ExtraKeyProps } from "./fieldKeys";
import { useLiveWhile, useClosing, useClosingField, useStillOpen } from "./Closing";
import { useControlSize } from "./controlSize";

const SEARCH_KEYS = [{ key: "Escape" }];
const SEARCH_KEYS_WITH_ENTER = [{ key: "Escape" }, { key: "Enter" }, { key: "Enter", shiftKey: true }];
const SEARCH_KEYS_WITH_ARROWS = [{ key: "Escape" }, { key: "Enter" }, { key: "Enter", shiftKey: true }, { key: "ArrowUp" }, { key: "ArrowDown" }];
const BARE_SEARCH = { glyph: 13, glyphBox: 16 } as const;
const ESCAPE_KEY = [{ key: "Escape" }];

export function SearchField({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  width,
  style,
  look = "field",
  onSubmit,
  onEscape,
  onArrow,
  onBlur,
  inputRef,
  extraKeys,
  onExtraKey,
}: ExtraKeyProps & {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  width?: DimensionValue;
  style?: StyleProp<ViewStyle>;
  look?: "field" | "bare";
  onSubmit?: (shift: boolean) => void;
  onEscape?: () => void;
  onArrow?: (step: 1 | -1) => void;
  onBlur?: () => void;
  inputRef?: Ref<TextInput>;
}) {
  const theme = useTheme();
  const bare = look === "bare";
  const keyDownEvents = useKeyDownEvents(onArrow ? SEARCH_KEYS_WITH_ARROWS : onSubmit ? SEARCH_KEYS_WITH_ENTER : SEARCH_KEYS, extraKeys);
  const clearMotion = usePressScaleMotion(!!value && !bare, buttonMotion.iconPressScale);
  const field = useClosingField(inputRef);
  const closing = field.closing;
  const live = useLiveWhile(closing);
  return (
    <View
      style={[
        bare
          ? { width, flexDirection: "row", alignItems: "center", gap: space.s }
          : {
              width,
              height: 28,
              borderRadius: radius.tile,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: space.m,
              gap: space.xs,
              backgroundColor: theme.field,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: theme.fieldBorder,
            },
        style,
      ]}
    >
      {bare ? (
        <Symbol name="magnifyingglass" size={BARE_SEARCH.glyph} color={theme.textSecondary} style={{ width: BARE_SEARCH.glyphBox, height: BARE_SEARCH.glyphBox }} />
      ) : (
        <Symbol name="magnifyingglass" size={12} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
      )}
      <TextInput
        ref={field.ref}
        value={value}
        onChangeText={live(onChangeText)}
        editable={!closing}
        placeholder={placeholder}
        placeholderTextColor={bare ? theme.placeholder : theme.textTertiary}
        selectionColor={theme.selection}
        autoFocus={autoFocus}
        enableFocusRing={false}
        ardiaCentersCapitals
        onBlur={onBlur}
        keyDownEvents={keyDownEvents}
        onKeyDown={live((e) => {
          const { key, shiftKey } = e.nativeEvent;
          if (key === "Escape") (onEscape ?? (() => onChangeText("")))();
          else if (key === "Enter") onSubmit?.(!!shiftKey);
          else if (key === "ArrowDown") onArrow?.(1);
          else if (key === "ArrowUp") onArrow?.(-1);
          else if (onExtraKey?.(e.nativeEvent)) e.stopPropagation();
        })}
        style={{ flex: 1, ...(bare ? typeScale.title : typeScale.body), color: theme.textPrimary, paddingVertical: 0 }}
      />
      {value && !bare ? (
        <View tooltip="Clear">
          <Pressable disabled={closing} onPress={live(() => onChangeText(""))} onAccessibilityTap={tapActivates(live(() => onChangeText("")))} accessibilityRole="button" accessibilityLabel="Clear" onPressIn={clearMotion.onPressIn} onPressOut={clearMotion.onPressOut}>
            <Animated.View style={[CLEAR_GLYPH, clearMotion.scale ? { transform: [{ scale: clearMotion.scale }] } : null]}>
              <Symbol name="xmark.circle.fill" size={12} color={theme.textTertiary} style={CLEAR_GLYPH} />
            </Animated.View>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  secure,
  onSubmit,
  onEscape,
  onBlur,
  selectOnFocus,
  multiline,
  mono,
  invalid,
  disabled,
  width,
  style,
  extraKeys,
  onExtraKey,
}: ExtraKeyProps & {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  secure?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  onEscape?: () => void;
  onBlur?: () => void;
  selectOnFocus?: boolean;
  multiline?: boolean;
  mono?: boolean;
  invalid?: boolean;
  width?: DimensionValue;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const sized = useControlSize();
  const keyDownEvents = useKeyDownEvents(onEscape ? ESCAPE_KEY : undefined, extraKeys);
  const field = useClosingField();
  const locked = disabled || field.closing;
  const live = useLiveWhile(field.closing);
  return (
    <OutsidePressArea style={[{ width, opacity: disabled ? opacity.disabled : 1 }, style]}>
      <View
        style={{
          height: multiline ? MULTILINE_HEIGHT : sized.field,
          borderRadius: sized.radius,
          justifyContent: multiline ? "flex-start" : "center",
          paddingHorizontal: space.m,
          paddingVertical: multiline ? space.m : 0,
          backgroundColor: theme.field,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: invalid ? theme.destructive : theme.fieldBorder,
        }}
      >
        <TextInput
          ref={field.ref}
          value={value}
          onChangeText={disabled ? undefined : live(onChangeText)}
          editable={!locked}
          placeholder={placeholder}
          placeholderTextColor={theme.textTertiary}
          selectionColor={theme.selection}
          autoFocus={autoFocus}
          secureTextEntry={secure}
          enableFocusRing={false}
          selectTextOnFocus={selectOnFocus}
          multiline={multiline}
          ardiaCentersCapitals={!multiline}
          autoCorrect={mono ? false : undefined}
          spellCheck={mono ? false : undefined}
          onSubmitEditing={disabled ? undefined : live(onSubmit)}
          onBlur={onBlur}
          keyDownEvents={keyDownEvents}
          onKeyDown={live((e) => {
            if (e.nativeEvent.key === "Escape") onEscape?.();
            else if (onExtraKey?.(e.nativeEvent)) e.stopPropagation();
          })}
          style={[{ ...typeScale.body, color: theme.textPrimary, paddingVertical: 0 }, multiline && multilineText(), mono && monoFace()]}
        />
      </View>
    </OutsidePressArea>
  );
}

const MULTILINE_HEIGHT = 96;
const multilineText = perLook(() => ({ flex: 1, lineHeight: proseLineHeight.body }));

export type Option<T extends string> = { value: T; title: string; separatorBefore?: boolean };

export function PopUp<T extends string>({
  value,
  options,
  onChange,
  minWidth = 120,
  disabled,
  accessibilityLabel,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  minWidth?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const native = useNativeForm();
  const { hovered, hoverProps } = useHover();
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const stillOpen = useStillOpen(!closing);
  const pressMotion = usePressScaleMotion(!disabled && !native, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  const current = options.find((o) => o.value === value);
  const labelled = accessibilityLabel ? { accessibilityLabel, accessibilityValue: { text: current?.title ?? "" } } : {};
  const open = async () => {
    const items: MenuItem[] = options.flatMap((o) => [
      ...(o.separatorBefore ? [{ separator: true as const }] : []),
      { id: o.value, title: o.title, checked: o.value === value },
    ]);
    if (closing) return;
    const choice = await showMenu(withIconNames(items));
    if (choice !== null && choice !== value && stillOpen()) onChange(choice as T);
  };
  return (
    <View {...hoverProps} style={{ opacity: disabled ? opacity.disabled : 1 }}>
      <Pressable disabled={disabled || closing} onPress={live(open)} onAccessibilityTap={disabled || closing ? undefined : tapActivates(live(open))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" {...labelled}>
        {({ pressed }) =>
          native ? (
            <View style={[PLAIN_POPUP, { backgroundColor: pressed ? theme.controlPressed : hovered ? theme.controlHover : undefined }]}>
              <Text numberOfLines={1} ardiaCentersCapitals style={{ ...typeScale.body, color: theme.textPrimary, flexShrink: 1 }}>
                {current?.title ?? ""}
              </Text>
              <Symbol name={POP_UP_CHROME.indicator === "chevronDown" ? "chevron.down" : "chevron.up.chevron.down"} size={9} weight="semibold" color={theme.textSecondary} style={PLAIN_POPUP_GLYPH} />
            </View>
          ) : (
          <Animated.View
            style={[
              {
                minWidth,
                height: 22,
                borderRadius: radius.control,
                paddingLeft: space.m,
                paddingRight: space.xs,
                flexDirection: "row",
                alignItems: "center",
                gap: space.s,
                backgroundColor: pressed ? theme.controlPressed : hovered ? theme.controlHover : theme.control,
                borderWidth: StyleSheet.hairlineWidth * 2,
                borderColor: theme.controlBorder,
              },
              scaleStyle,
            ]}
          >
            <Text numberOfLines={1} ardiaCentersCapitals style={[POP_UP_TITLE, typeScale.body, { color: theme.textPrimary }]}>
              {current?.title ?? ""}
            </Text>
            {POP_UP_CHROME.indicator === "chevronDown" ? (
              <Symbol name="chevron.down" size={8} weight="bold" color={theme.textSecondary} style={POP_UP_INDICATOR} />
            ) : (
              <View style={{ ...POP_UP_INDICATOR, borderRadius: radius.control, backgroundColor: theme.formAccent, alignItems: "center", justifyContent: "center" }}>
                <Symbol name="chevron.up.chevron.down" size={8} weight="bold" color={theme.onAccent} style={POP_UP_INDICATOR} />
              </View>
            )}
          </Animated.View>
          )
        }
      </Pressable>
    </View>
  );
}

const POP_UP_INDICATOR = { width: 16, height: 16 } as const;
const POP_UP_TITLE = POP_UP_CHROME.growsToItsTitle ? ({ flexGrow: 1, flexShrink: 1 } as const) : ({ flex: 1 } as const);

const CLEAR_GLYPH = { width: 16, height: 16 } as const;
const PLAIN_POPUP = { height: 22, maxWidth: 260, borderRadius: radius.control, paddingLeft: space.s, paddingRight: space.xxs, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs } as const;
const PLAIN_POPUP_GLYPH = { width: 10, height: 14 } as const;
