import { modifiersOf, type ClickModifiers } from "../../lib/keys";
import { Symbol } from "./Symbol";
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { buttonMotion, curve, duration, usePressScaleMotion } from "./motion";
import { useTheme } from "./theme";
import { capsule, lineHeight, opacity, radius, space, font as typeScale } from "./tokens";
import { checkboxA11y, spaceActivates, tapActivates } from "./a11y";
import { useLiveWhile, useClosing } from "./Closing";

const CHECK_RING = { s: { box: 14, glyph: 8 }, m: { box: 18, glyph: 10 } } as const;
const CHECK_RING_BORDER = 1.5;
const CHECK_BOX = 14;

export function CheckBoxFace({ on, mixed = false, disabled = false }: { on: boolean; mixed?: boolean; disabled?: boolean }) {
  const theme = useTheme();
  const filled = on || mixed;
  return (
    <View
      pointerEvents="none"
      style={{
        width: CHECK_BOX,
        height: CHECK_BOX,
        borderRadius: radius.control,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? theme.formAccent : theme.control,
        borderWidth: filled ? 0 : StyleSheet.hairlineWidth * 2,
        borderColor: theme.controlBorder,
        opacity: disabled ? opacity.disabled : 1,
      }}
    >
      {filled && <Symbol name={mixed && !on ? "minus" : "checkmark"} size={9} weight="bold" color={theme.onAccent} style={CHECK_GLYPH} />}
    </View>
  );
}

const CHECK_GLYPH = { width: CHECK_BOX, height: CHECK_BOX } as const;

export function Checkbox({ value, onChange, label, accessibilityLabel, disabled, mixed, focusable, look = "form", size = "m", labelSize = "body" }: {
  value: boolean;
  onChange?: (value: boolean, modifiers?: ClickModifiers) => void;
  label?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  mixed?: boolean;
  focusable?: boolean;
  look?: "form" | "ring";
  size?: keyof typeof CHECK_RING;
  labelSize?: "body" | "small";
}) {
  const theme = useTheme();
  const closing = useClosing();
  const on = value || mixed;
  const active = !!onChange && !disabled && !closing;
  const live = useLiveWhile(closing);
  const pressMotion = usePressScaleMotion(!!onChange && !disabled, buttonMotion.iconPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  const toggle = () => onChange?.(!value);
  const press = {
    disabled: !active,
    focusable: focusable && active,
    onPressIn: pressMotion.onPressIn,
    onPressOut: pressMotion.onPressOut,
    onKeyDown: active ? live(spaceActivates(toggle)) : undefined,
    onAccessibilityTap: active ? tapActivates(live(toggle)) : undefined,
    ...checkboxA11y(mixed && !value ? "mixed" : value, disabled, accessibilityLabel ?? label),
  };
  if (look === "ring" && !onChange) return <RingCheck on={!!on} size={size} />;
  if (look === "ring")
    return (
      <Pressable {...press} onPress={live(toggle)} style={{ opacity: disabled ? opacity.disabled : 1 }}>
        <Animated.View style={[CHECK_RING_FRAME[size], scaleStyle]}>
          <RingCheck on={!!on} size={size} />
        </Animated.View>
      </Pressable>
    );
  return (
    <Pressable
      {...press}
      onPress={live((e) => onChange?.(!value, modifiersOf(e)))}
      style={{ flexDirection: "row", alignItems: labelSize === "small" ? "flex-start" : "center", gap: space.m, opacity: disabled ? opacity.disabled : 1 }}
    >
      <Animated.View style={[CHECK_BOX_FRAME, scaleStyle]}>
        <CheckBoxFace on={value} mixed={!!mixed} />
      </Animated.View>
      {label ? <Text style={labelSize === "small" ? { ...typeScale.small, lineHeight: lineHeight.body, flex: 1, color: theme.textPrimary } : { ...typeScale.body, color: theme.textPrimary }}>{label}</Text> : null}
    </Pressable>
  );
}

const CHECK_BOX_FRAME = { width: CHECK_BOX, height: CHECK_BOX, alignItems: "center", justifyContent: "center" } as const;
const CHECK_RING_FRAME = { s: { width: 14, height: 14 }, m: { width: 18, height: 18 } } as const;

function RingCheck({ on, size = "m" }: { on: boolean; size?: keyof typeof CHECK_RING }) {
  const theme = useTheme();
  const { box, glyph } = CHECK_RING[size];
  const t = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: on ? 1 : 0, duration: duration.base, easing: curve.enter, useNativeDriver: true }).start();
  }, [on]);
  return (
    <View
      style={{
        width: box,
        height: box,
        borderRadius: capsule(box),
        backgroundColor: theme.ringRadioFill,
        borderWidth: CHECK_RING_BORDER,
        borderColor: theme.ringRadioBorder,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          left: -CHECK_RING_BORDER,
          top: -CHECK_RING_BORDER,
          width: box,
          height: box,
          borderRadius: capsule(box),
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.ringRadioOn,
          opacity: t,
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
        }}
      >
        <Symbol name="checkmark" size={glyph} weight="bold" color={theme.onPrimary} style={{ width: box, height: box }} />
      </Animated.View>
    </View>
  );
}
