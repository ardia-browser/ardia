import { useEffect } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useDesign } from "./design";
import { MaterialSwitchTrack } from "./MaterialSurfaces";
import { springs } from "./motion";
import { useTheme } from "./theme";
import { capsule, ink, shadowRadius, toggleLayout } from "./tokens";

const TRAVEL = toggleLayout.width - toggleLayout.knob - toggleLayout.inset * 2;

export function Toggle({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onChange(!value)}
      style={disabled ? styles.disabled : undefined}
    >
      <ToggleTrack value={value} />
    </Pressable>
  );
}

export function ToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  if (useDesign() === "material") return <MaterialSwitchTrack value={value} disabled={disabled} />;
  return <ClassicToggleTrack value={value} disabled={disabled} />;
}

function ClassicToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  const theme = useTheme();
  const position = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    position.value = withSpring(value ? 1 : 0, springs.barPress);
  }, [position, value]);
  const off = theme.tertiaryFill;
  const on = theme.switchOn;
  const trackStyle = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(position.value, [0, 1], [off, on]) }), [off, on]);
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * TRAVEL }] }));
  return (
    <Animated.View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.track, trackStyle, disabled ? styles.disabled : null]}>
      <Animated.View style={[styles.knob, knobStyle]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  track: { width: toggleLayout.width, height: toggleLayout.height, borderRadius: capsule(toggleLayout.height), padding: toggleLayout.inset, justifyContent: "center" },
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
  disabled: { opacity: 0.4 },
});
