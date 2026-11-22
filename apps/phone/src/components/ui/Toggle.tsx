import { useEffect, type ReactNode } from "react";
import { Platform, PlatformColor, Pressable, StyleSheet, Text, View, type ColorValue, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { useDesign } from "./design";
import { MaterialSwitchTrack } from "./MaterialSurfaces";
import { motionAliases } from "./motion";
import { usePressStyle } from "./pressFeedback";
import { useTheme } from "./theme";
import { capsule, font, ink, press, shadowRadius, space, toggleLayout } from "./tokens";

const TRAVEL = toggleLayout.width - toggleLayout.knob - toggleLayout.inset * 2;

const KNOB_SLOP = space.s;

export type TogglePress = "row" | "knob";

type ToggleProps = { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string; hint?: string; testID?: string };

export function Toggle({ value, disabled, onChange, label, hint, testID }: ToggleProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={KNOB_SLOP}
      onPress={() => onChange(!value)}
    >
      <ToggleTrack value={value} disabled={disabled} />
    </Pressable>
  );
}

type ToggleRowProps = ToggleProps & { press?: TogglePress; detail?: string; detailInset?: number; children?: ReactNode; style?: StyleProp<ViewStyle> };

export function ToggleRow({ value, disabled = false, onChange, label, hint, detail, detailInset = 0, press: pressMode = "row", testID, children, style }: ToggleRowProps) {
  const theme = useTheme();
  const rowStyle = usePressStyle("row", { style: [styles.row, style] });
  const words = (
    <View style={styles.words} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {children ?? <Text style={[font.body, { color: disabled ? theme.disabled : theme.label }]}>{label}</Text>}
      {detail ? <Text style={[font.footnote, { color: theme.secondaryLabel, marginLeft: detailInset }]}>{detail}</Text> : null}
    </View>
  );
  if (pressMode === "knob") {
    return (
      <View style={[styles.row, style]}>
        {words}
        <Toggle testID={testID} value={value} disabled={disabled} onChange={onChange} label={detail ? `${label}, ${detail}` : label} hint={hint} />
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={rowStyle}
    >
      {words}
      <ToggleTrack value={value} disabled={disabled} />
    </Pressable>
  );
}

export function ToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  if (useDesign() === "material") return <MaterialSwitchTrack value={value} disabled={disabled} />;
  return <ClassicToggleTrack value={value} disabled={disabled} />;
}

export type SwitchColors = { on: ColorValue; off: ColorValue };

export const SYSTEM_SWITCH_COLOR_NAMES = { on: "systemGreen", off: "secondarySystemFill" } as const;

export function switchColors(tokens: { switchOn: string; switchOff: string }, os: string): SwitchColors {
  if (os === "ios") return { on: PlatformColor(SYSTEM_SWITCH_COLOR_NAMES.on), off: PlatformColor(SYSTEM_SWITCH_COLOR_NAMES.off) };
  return { on: tokens.switchOn, off: tokens.switchOff };
}

function ClassicToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const position = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    position.value = reduceMotion ? withTiming(value ? 1 : 0, { duration: motionAliases.toggleKnobReducedMs }) : withSpring(value ? 1 : 0, motionAliases.toggleKnob);
  }, [position, value, reduceMotion]);
  const colors = switchColors(theme, Platform.OS);
  const onStyle = useAnimatedStyle(() => ({ opacity: position.value }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * TRAVEL }] }));
  return (
    <View testID="toggleTrack" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.track, { backgroundColor: colors.off }, disabled ? styles.disabled : null]}>
      <Animated.View testID="toggleTrackOn" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.onFill, { backgroundColor: colors.on }, onStyle]} />
      <Animated.View style={[styles.knob, knobStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m },
  words: { flex: 1, gap: space.tight },
  track: { width: toggleLayout.width, height: toggleLayout.height, borderRadius: capsule(toggleLayout.height), padding: toggleLayout.inset, justifyContent: "center" },
  onFill: { borderRadius: capsule(toggleLayout.height) },
  knob: {
    width: toggleLayout.knob,
    height: toggleLayout.knob,
    borderRadius: capsule(toggleLayout.knob),
    backgroundColor: ink.white,
    elevation: 2,
    shadowColor: ink.knobShadow,
    shadowOpacity: 1,
    shadowRadius: shadowRadius.knob,
    shadowOffset: { width: 0, height: 1 },
  },
  disabled: { opacity: press.disabledOpacity },
});
