import { useCallback, type ReactNode } from "react";
import { Pressable, type Insets, type PressableStateCallbackType, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "./theme";
import { press } from "./tokens";

export type PressKind = "text" | "icon" | "filled" | "row";

const pressedOpacityOf: Record<Exclude<PressKind, "row">, number> = { text: press.textOpacity, icon: press.iconOpacity, filled: press.filledOpacity };

export function pressedLook(kind: PressKind, pressed: boolean, disabled: boolean, rowPressed: string): ViewStyle | null {
  if (disabled) return { opacity: press.disabledOpacity };
  if (!pressed) return null;
  return kind === "row" ? { backgroundColor: rowPressed } : { opacity: pressedOpacityOf[kind] };
}

type StyleOrState = StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);

export function usePressStyle(kind: PressKind, { disabled = false, style }: { disabled?: boolean; style?: StyleOrState } = {}) {
  const { rowPressed } = useTheme();
  return useCallback(
    (state: PressableStateCallbackType): StyleProp<ViewStyle> => [typeof style === "function" ? style(state) : style, pressedLook(kind, state.pressed, disabled, rowPressed)],
    [kind, disabled, style, rowPressed],
  );
}

export type TappableRole = "button" | "link" | "tab" | "menuitem";

type TappableProps = {
  kind: PressKind;
  label: string;
  hint?: string;
  role?: TappableRole;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onPressIn?: () => void;
  hitSlop?: Insets | number;
  style?: StyleOrState;
  testID?: string;
  children: ReactNode;
};

export function Tappable({ kind, label, hint, role = "button", selected, disabled = false, busy = false, onPress, onLongPress, onPressIn, hitSlop, style, testID, children }: TappableProps) {
  const blocked = disabled || busy;
  const pressStyle = usePressStyle(kind, { disabled, style });
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: blocked, busy, ...(selected === undefined ? {} : { selected }) }}
      disabled={blocked}
      hitSlop={hitSlop}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
      style={pressStyle}
    >
      {children}
    </Pressable>
  );
}
