import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { modifiersOf, type ClickModifiers } from "../../lib/keys";
import { Symbol } from "./Symbol";
import { buttonMotion, curve, duration, usePressScaleMotion } from "./motion";
import { useTheme } from "./theme";
import { capsule, opacity, radius, space, font as typeScale } from "./tokens";
import { useControlLabel } from "./controlLabel";

const CHECK_RING = { s: { box: 14, glyph: 8 }, m: { box: 18, glyph: 10 } } as const;
const CHECK_RING_BORDER = 1.5;

export function Checkbox({
  value,
  onChange,
  label,
  disabled,
  mixed,
  look = "form",
  size = "m",
}: {
  value: boolean;
  onChange?: (value: boolean, modifiers?: ClickModifiers) => void;
  label?: string;
  disabled?: boolean;
  mixed?: boolean;
  look?: "form" | "ring";
  size?: keyof typeof CHECK_RING;
}) {
  const theme = useTheme();
  const on = value || mixed;
  const accessibilityLabel = useControlLabel(label);
  const checked = mixed && !value ? "mixed" : value;
  const toggle = onChange && !disabled ? () => onChange(!value) : undefined;
  const pressMotion = usePressScaleMotion(!!onChange && !disabled, buttonMotion.iconPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  if (look === "ring" && !onChange) return <RingCheck on={!!on} size={size} />;
  if (look === "ring")
    return (
      <Pressable
        disabled={disabled}
        onPress={() => onChange?.(!value)}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
        accessibilityRole="checkbox"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ checked, disabled }}
        onAccessibilityTap={toggle}
        style={{ opacity: disabled ? opacity.disabled : 1 }}
      >
        <Animated.View style={[CHECK_RING_FRAME[size], scaleStyle]}>
          <RingCheck on={!!on} size={size} />
        </Animated.View>
      </Pressable>
    );
  return (
    <Pressable
      disabled={disabled || !onChange}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled: disabled || !onChange }}
      onAccessibilityTap={toggle}
      onPress={(e) => onChange?.(!value, modifiersOf(e))}
      onPressIn={pressMotion.onPressIn}
      onPressOut={pressMotion.onPressOut}
      style={{ flexDirection: "row", alignItems: "center", gap: space.m, opacity: disabled ? opacity.disabled : 1 }}
    >
      <Animated.View style={[CHECK_BOX_FRAME, scaleStyle]}>
        <View
          style={{
            width: 14,
            height: 14,
            borderRadius: radius.control,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: on ? theme.formAccent : theme.control,
            borderWidth: on ? 0 : StyleSheet.hairlineWidth * 2,
            borderColor: theme.controlBorder,
          }}
        >
          {on && <Symbol name={mixed && !value ? "minus" : "checkmark"} size={9} weight="bold" color={theme.onAccent} style={{ width: 14, height: 14 }} />}
        </View>
      </Animated.View>
      {label ? <Text style={{ ...typeScale.body, color: theme.textPrimary }}>{label}</Text> : null}
    </Pressable>
  );
}

const CHECK_BOX_FRAME = { width: 14, height: 14, alignItems: "center", justifyContent: "center" } as const;
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
