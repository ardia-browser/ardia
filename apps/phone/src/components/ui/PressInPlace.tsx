import { createContext, useContext, useMemo, type ComponentProps, type ReactNode, type Ref } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { type PressKind } from "./pressFeedback";
import { screenReaderActions } from "./screenReaderActions";
import { useTheme } from "./theme";
import { ink, press } from "./tokens";

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
  busy?: boolean;
  grow?: boolean;
  kind?: PressKind;
  dims?: PressDims;
  ref?: Ref<ViewInstance>;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

export type PressDims = "button" | "glyph";

const HeldDown = createContext<SharedValue<number> | null>(null);

const PRESSED_OPACITY: Record<Exclude<PressKind, "row">, number> = { text: press.textOpacity, icon: press.iconOpacity, filled: press.filledOpacity };

export function pressedOpacity(kind: Exclude<PressKind, "row">, held: number): number {
  "worklet";
  return 1 - (1 - PRESSED_OPACITY[kind]) * held;
}

export function usePressTouch(testID: string, disabled: boolean) {
  const held = useSharedValue(0);
  const touch = useMemo(
    () =>
      Gesture.Manual()
        .withTestId(testID)
        .enabled(!disabled)
        .shouldCancelWhenOutside(true)
        .onTouchesDown(() => {
          held.value = 1;
        })
        .onTouchesUp((_event, manager) => {
          held.value = 0;
          manager.fail();
        })
        .onTouchesCancelled((_event, manager) => {
          held.value = 0;
          manager.fail();
        })
        .onFinalize(() => {
          held.value = 0;
        }),
    [held, testID, disabled],
  );
  return { held, touch };
}

export function PressInPlace({ label, hint, value, longPressLabel, actions, onPress, onLongPress, onPressIn, disabled = false, checked, busy, grow, kind = "icon", dims = "button", ref, style, children }: Props) {
  const { rowPressed } = useTheme();
  const { held, touch } = usePressTouch(`pressInPlace:${label}`, disabled);
  const dimsButton = dims === "button";
  const look = useAnimatedStyle(() => {
    if (!dimsButton) return {};
    const lit = disabled ? 0 : held.value;
    if (kind === "row") return { backgroundColor: lit ? rowPressed : ink.clear };
    return { opacity: pressedOpacity(kind, lit) };
  }, [disabled, dimsButton, kind, rowPressed]);
  const exposed = actions
    ? screenReaderActions([{ name: "activate", run: onPress }, ...(onLongPress ? [{ name: "longpress", label: longPressLabel, run: onLongPress }] : []), ...actions])
    : {};
  return (
    <Pressable
      ref={ref}
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={value ? { text: value } : undefined}
      {...exposed}
      accessibilityState={{ disabled, ...(checked === undefined ? null : { checked }), ...(busy === undefined ? null : { busy }) }}
      disabled={disabled}
      style={grow ? styles.grow : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
    >
      <GestureDetector gesture={touch}>
        <Animated.View testID="pressInPlaceFace" collapsable={false} style={[style, look]}>
          <HeldDown.Provider value={dimsButton ? null : held}>{children}</HeldDown.Provider>
        </Animated.View>
      </GestureDetector>
    </Pressable>
  );
}

export function GlyphPressFace({ testID, disabled = false, children }: { testID: string; disabled?: boolean; children: ReactNode }) {
  const { held, touch } = usePressTouch(testID, disabled);
  return (
    <GestureDetector gesture={touch}>
      <Animated.View testID="glyphPressFace" collapsable={false}>
        <HeldDown.Provider value={held}>{children}</HeldDown.Provider>
      </Animated.View>
    </GestureDetector>
  );
}

export function PressedGlyph({ style, ...rest }: ComponentProps<typeof Animated.View>) {
  const held = useContext(HeldDown);
  const idle = useSharedValue(0);
  const from = held ?? idle;
  const dim = useAnimatedStyle(() => ({ opacity: pressedOpacity("icon", from.value) }));
  return <Animated.View {...rest} style={[style, dim]} />;
}

const styles = StyleSheet.create({ grow: { flex: 1 } });
