import type { ReactNode, Ref } from "react";
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityValue,
  type StyleProp,
  type ViewInstance,
  type ViewStyle,
} from "react-native";
import { Pressable, type PressableEvent } from "react-native-gesture-handler";
import { withAlpha } from "../../lib/color";
import type { MaterialScheme } from "../../lib/material/schemes";
import { MATERIAL_STATE } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";
import { materialShape, materialSize } from "./materialTokens";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";

export type MaterialIconButtonVariant = "standard" | "filled" | "tonal" | "outlined";
export type MaterialIconButtonSize = "default" | "compact" | "narrow";

export type MaterialIconButtonProps = {
  testID?: string;
  label: string;
  hint?: string;
  value?: AccessibilityValue;
  icon?: SymbolName;
  iconSize?: number;
  iconStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  variant?: MaterialIconButtonVariant;
  size?: MaterialIconButtonSize;
  enabled?: boolean;
  selected?: boolean;
  ink?: string;
  scheme?: MaterialScheme;
  turned?: boolean;
  flipped?: boolean;
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  onPress: (event: PressableEvent) => void;
  onPressIn?: (event: PressableEvent) => void;
  onLongPress?: (event: PressableEvent) => void;
  buttonRef?: Ref<ViewInstance>;
};

type IconButtonColors = {
  container?: string;
  border?: string;
  content: string;
};

const ICON_BUTTON_INSET = (materialSize.touchTarget - materialSize.iconButton) / 2;
const COMPACT_HIT_SLOP = ICON_BUTTON_INSET;
const NARROW_HIT_SLOP = { left: ICON_BUTTON_INSET, right: ICON_BUTTON_INSET };
const RIPPLE_RADIUS = materialSize.iconButton / 2;

export function materialIconButtonColors(
  scheme: MaterialScheme,
  variant: MaterialIconButtonVariant,
  enabled: boolean,
  selected?: boolean,
  ink?: string,
): IconButtonColors {
  if (!enabled) {
    const content = withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent);
    const disabledContainer = withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContainer);
    if (variant === "filled" || variant === "tonal") return { container: disabledContainer, content };
    if (variant === "outlined") {
      return selected ? { container: disabledContainer, content } : { border: disabledContainer, content };
    }
    return { content };
  }
  if (variant === "filled") {
    const unselected = selected === false;
    return {
      container: unselected ? scheme.surfaceContainerHighest : scheme.primary,
      content: ink ?? (unselected ? scheme.primary : scheme.onPrimary),
    };
  }
  if (variant === "tonal") {
    const unselected = selected === false;
    return {
      container: unselected ? scheme.surfaceContainerHighest : scheme.secondaryContainer,
      content: ink ?? (unselected ? scheme.onSurfaceVariant : scheme.onSecondaryContainer),
    };
  }
  if (variant === "outlined") {
    return selected
      ? { container: scheme.inverseSurface, content: ink ?? scheme.inverseOnSurface }
      : { border: scheme.outline, content: ink ?? scheme.onSurfaceVariant };
  }
  return { content: ink ?? (selected ? scheme.primary : scheme.onSurfaceVariant) };
}

export const materialIconRipple = (color: string, foreground = false) => ({
  color: withAlpha(color, MATERIAL_STATE.pressed),
  borderless: true,
  radius: RIPPLE_RADIUS,
  ...(foreground ? { foreground: true } : null),
});

export function MaterialIconButton({
  testID,
  label,
  hint,
  value,
  icon,
  iconSize = materialSize.icon,
  iconStyle,
  children,
  variant = "standard",
  size = "default",
  enabled = true,
  selected,
  ink,
  scheme,
  turned = false,
  flipped = false,
  accessibilityActions,
  onAccessibilityAction,
  onPress,
  onPressIn,
  onLongPress,
  buttonRef,
}: MaterialIconButtonProps) {
  const theme = useMaterialTheme();
  const activeScheme = scheme ?? theme.scheme;
  const colors = materialIconButtonColors(activeScheme, variant, enabled, selected, ink);
  const ripple = materialIconRipple(colors.content, Boolean(colors.container));
  const hitSlop = size === "compact" ? COMPACT_HIT_SLOP : size === "narrow" ? NARROW_HIT_SLOP : undefined;
  const targetStyle = size === "compact" ? styles.compact : size === "narrow" ? styles.narrow : styles.target;
  const accessibilityState = { disabled: !enabled, ...(selected === undefined ? {} : { selected }) };
  const transform = turned ? styles.turned : flipped ? styles.flipped : null;

  return (
    <Pressable
      ref={buttonRef}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={value}
      accessibilityState={accessibilityState}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      disabled={!enabled}
      hitSlop={hitSlop}
      android_ripple={ripple}
      onPressIn={onPressIn}
      onPress={onPress}
      onLongPress={onLongPress}
      style={targetStyle}
    >
      <View
        pointerEvents="none"
        style={[
          styles.container,
          colors.container ? { backgroundColor: colors.container } : null,
          colors.border ? [styles.outlined, { borderColor: colors.border }] : null,
        ]}
      >
        {children ?? (icon ? (
          <View style={[transform, iconStyle]}>
            <Symbol name={icon} size={iconSize} color={colors.content} />
          </View>
        ) : null)}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    width: materialSize.touchTarget,
    height: materialSize.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: materialShape.full,
  },
  compact: {
    width: materialSize.iconButton,
    height: materialSize.iconButton,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: materialShape.full,
  },
  narrow: {
    width: materialSize.iconButton,
    height: materialSize.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: materialShape.full,
  },
  container: {
    width: materialSize.iconButton,
    height: materialSize.iconButton,
    borderRadius: materialShape.full,
    alignItems: "center",
    justifyContent: "center",
  },
  outlined: { borderWidth: 1 },
  turned: { transform: [{ rotate: "90deg" }] },
  flipped: { transform: [{ scaleX: -1 }] },
});
