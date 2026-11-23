import { Symbol } from "./Symbol";
import type { ReactNode } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { Divider } from "./Divider";
import { useGlass } from "./Glass";
import { HoverFill } from "./HoverFill";
import { PANEL } from "./Popover";
import { useTheme, type Theme } from "./theme";
import { opacity, space, typeFace } from "./tokens";
import { useHover } from "./useHover";
import { radioA11y, spaceActivates, tapActivates } from "./a11y";
import { useLiveWhile, useClosing } from "./Closing";

export const menuRowFill = (theme: Theme, pressed = false) => (pressed ? theme.popoverRowPressed : theme.rowHover);

const RING_WIDTH = 1.5;
const CHECK = { glyph: 11, slot: { width: 16, height: 16 } } as const;

export function MenuRow({
  icon,
  leading,
  iconColor,
  title,
  detail,
  detailColor,
  accessory,
  onPress,
  disabled,
  destructive,
  selected,
  checked,
  minHeight = PANEL.rowHeight,
  ring,
  tooltip,
}: {
  icon?: string;
  leading?: ReactNode;
  iconColor?: string;
  title: string;
  detail?: string;
  detailColor?: string;
  accessory?: ReactNode;
  onPress?: (event: GestureResponderEvent) => void;
  disabled?: boolean;
  destructive?: boolean;
  selected?: boolean;
  checked?: boolean;
  minHeight?: number;
  ring?: boolean;
  tooltip?: string;
}) {
  const theme = useTheme();
  const glass = useGlass();
  const { hovered, hoverProps } = useHover();
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const tint = destructive ? theme.destructive : theme.textPrimary;
  const interactive = !!onPress && !disabled;
  const marked = !!(selected || checked);
  const content = (pressed: boolean) => {
    const lit = interactive && (pressed || hovered);
    return (
      <View
        style={{
          minHeight,
          marginHorizontal: PANEL.rowInset,
          paddingHorizontal: PANEL.rowPadding,
          borderRadius: PANEL.rowRadius,
          flexDirection: "row",
          alignItems: "center",
          gap: PANEL.iconGap,
          opacity: disabled ? opacity.disabled : 1,
          backgroundColor: marked ? theme.rowSelected : undefined,
          borderWidth: ring ? RING_WIDTH : undefined,
          borderColor: ring ? theme.accent : undefined,
        }}
      >
        {interactive ? <HoverFill shown={lit} instant={pressed} color={menuRowFill(theme, pressed)} radius={PANEL.rowRadius} glass={glass ? (pressed ? "pressed" : "lit") : undefined} /> : null}
        {leading ? (
          <View style={{ width: PANEL.iconSlot, height: PANEL.iconSlot, alignItems: "center", justifyContent: "center" }}>{leading}</View>
        ) : icon ? (
          <Symbol name={icon} size={PANEL.iconSize} color={iconColor ?? (destructive ? tint : theme.icon)} style={{ width: PANEL.iconSlot, height: PANEL.iconSlot }} />
        ) : null}
        <View style={{ flex: 1, paddingVertical: space.s }}>
          <Text numberOfLines={1} style={{ fontSize: PANEL.titleSize, color: tint, ...typeFace() }}>
            {title}
          </Text>
          {detail ? (
            <Text numberOfLines={2} style={{ fontSize: PANEL.subtitleSize, color: detailColor ?? theme.textSecondary, ...typeFace() }}>
              {detail}
            </Text>
          ) : null}
        </View>
        {accessory}
        {checked === undefined ? null : checked ? <Symbol name="checkmark" size={CHECK.glyph} weight="semibold" color={theme.textPrimary} style={CHECK.slot} /> : <View style={CHECK.slot} />}
      </View>
    );
  };
  if (!onPress)
    return (
      <View {...hoverProps} tooltip={tooltip}>
        {content(false)}
      </View>
    );
  const choosable = checked !== undefined;
  const active = !disabled && !closing;
  return (
    <View {...hoverProps} tooltip={tooltip}>
      <Pressable
        onPress={live(onPress)} onAccessibilityTap={!active ? undefined : tapActivates(live(onPress))}
        disabled={!active}
        {...(choosable
          ? { ...radioA11y(!!checked), onKeyDown: active ? live(spaceActivates((e) => onPress(e as unknown as GestureResponderEvent))) : undefined }
          : { accessibilityRole: "button" as const, accessibilityState: selected === undefined ? { disabled: !!disabled } : { disabled: !!disabled, selected: !!selected } })}
      >
        {({ pressed }) => content(pressed)}
      </Pressable>
    </View>
  );
}

const SEPARATOR = { marginVertical: PANEL.separatorGap } as const;

export function MenuSeparator() {
  return <Divider inset="xl" style={SEPARATOR} />;
}
