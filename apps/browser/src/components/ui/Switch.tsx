import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View, type EasingFunction } from "react-native";
import { curve, duration } from "./motion";
import { useTheme } from "./theme";
import { ink, opacity } from "./tokens";
import { useNativeForm } from "./nativeForm";

export type SwitchLook = {
  width: number;
  height: number;
  knob: number;
  inset: number;
  offColor: string;
  onColor: string;
  knobBorder?: string;
  duration: number;
  easing: EasingFunction;
};

function Switch({
  value,
  onChange,
  disabled,
  look,
  animateExternalChanges = true,
  accessibilityLabel,
  asksFirst = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void | Promise<unknown>;
  disabled?: boolean;
  look: SwitchLook;
  animateExternalChanges?: boolean;
  accessibilityLabel?: string;
  asksFirst?: boolean;
}) {
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  const target = useRef(value);
  const shown = useRef(value);
  shown.current = value;
  const pressedAt = useRef(0);

  const slideTo = (on: boolean) => {
    if (target.current === on) return;
    target.current = on;
    Animated.timing(progress, { toValue: on ? 1 : 0, duration: look.duration, easing: look.easing, useNativeDriver: true }).start();
  };

  const jumpTo = (on: boolean) => {
    if (target.current === on) return;
    target.current = on;
    progress.stopAnimation();
    progress.setValue(on ? 1 : 0);
  };

  useEffect(() => (animateExternalChanges || Date.now() - pressedAt.current < USER_CHANGE_WINDOW_MS ? slideTo(value) : jumpTo(value)));

  const travel = look.width - look.knob - look.inset * 2;
  const radius = look.height / 2;
  return (
    <Pressable
      disabled={disabled}
      hitSlop={SWITCH_HIT_SLOP}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      onPress={() => {
        const next = !target.current;
        pressedAt.current = Date.now();
        if (!asksFirst) slideTo(next);
        const settled = onChange(next);
        if (settled instanceof Promise) void settled.finally(() => slideTo(shown.current));
      }}
      style={{ opacity: disabled ? opacity.disabled : 1 }}
    >
      <View pointerEvents="none" style={{ width: look.width, height: look.height, borderRadius: radius, backgroundColor: look.offColor, overflow: "hidden" }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: look.onColor, opacity: progress }]} />
        <Animated.View
          style={{
            position: "absolute",
            top: look.inset,
            left: look.inset,
            width: look.knob,
            height: look.knob,
            borderRadius: look.knob / 2,
            backgroundColor: ink.white,
            borderWidth: look.knobBorder ? StyleSheet.hairlineWidth : 0,
            borderColor: look.knobBorder,
            transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }],
          }}
        />
      </View>
    </Pressable>
  );
}

const USER_CHANGE_WINDOW_MS = 2000;
const FORM_SWITCH = { width: 32, height: 18, knob: 15, inset: 1.5 } as const;
const NATIVE_FORM_SWITCH = { width: 26, height: 15, knob: 13, inset: 1 } as const;
const SWITCH_HIT_SLOP = 6;

export function Toggle({
  value,
  onChange,
  disabled,
  look = "form",
  accessibilityLabel,
  asksFirst,
}: {
  value: boolean;
  onChange: (value: boolean) => void | Promise<unknown>;
  disabled?: boolean;
  look?: "form" | "panel";
  accessibilityLabel?: string;
  asksFirst?: boolean;
}) {
  const theme = useTheme();
  const native = useNativeForm();
  if (look === "panel")
    return (
      <Switch
        value={value}
        onChange={onChange}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        asksFirst={asksFirst}
        look={{ width: 30, height: 17, knob: 14, inset: 1.5, offColor: theme.toggleOff, onColor: theme.accent, duration: duration.base, easing: curve.enter }}
      />
    );
  return (
    <Switch
      value={value}
      onChange={onChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      asksFirst={asksFirst}
      animateExternalChanges={false}
      look={{ ...(native ? NATIVE_FORM_SWITCH : FORM_SWITCH), offColor: theme.switchOff, onColor: theme.formAccent, knobBorder: theme.knobBorder, duration: duration.base, easing: curve.enter }}
    />
  );
}
