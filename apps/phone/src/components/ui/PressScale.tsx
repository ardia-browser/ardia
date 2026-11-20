import { useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { springs } from "./motion";
import { screenReaderActions } from "./screenReaderActions";
import { browseLayout } from "./tokens";

type Props = {
  label: string;
  hint?: string;
  value?: string;
  longPressLabel?: string;
  actions?: { name: string; label: string; run: () => void }[];
  onPress: () => void;
  onLongPress?: () => void;
  onPressIn?: () => void;
  disabled?: boolean;
  checked?: boolean;
  grow?: boolean;
  pressedScale?: number;
  pressSpring?: { stiffness: number; damping: number; mass: number };
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

export function PressScale({ label, hint, value, longPressLabel, actions, onPress, onLongPress, onPressIn, disabled, checked, grow, pressedScale = browseLayout.barControlScale, pressSpring = springs.barPress, style, children }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const exposed = actions
    ? screenReaderActions([{ name: "activate", run: onPress }, ...(onLongPress ? [{ name: "longpress", label: longPressLabel, run: onLongPress }] : []), ...actions])
    : {};
  const to = (value: number) => Animated.spring(scale, { toValue: value, ...pressSpring, useNativeDriver: true }).start();
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={value ? { text: value } : undefined}
      {...exposed}
      accessibilityState={checked === undefined ? { disabled: Boolean(disabled) } : { disabled: Boolean(disabled), checked }}
      disabled={disabled}
      style={grow ? styles.grow : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => {
        onPressIn?.();
        to(pressedScale);
      }}
      onPressOut={() => to(1)}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({ grow: { flex: 1 } });
