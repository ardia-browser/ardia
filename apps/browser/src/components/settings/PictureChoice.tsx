import type { ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Box, Symbol, Text, useHover, useTheme } from "../ui";
import { SelectableCard } from "./SelectableCard";
import { pictureChoice } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";

const CHECK = { width: 14, height: 14 } as const;
const LABELS = { alignItems: "center" } as const;
const CAPTION = { textAlign: "center" } as const;

export function PictureChoice({
  title,
  accessibilityLabel,
  selected,
  onPress,
  tooltip,
  caption,
  size,
  children,
}: {
  title: string;
  accessibilityLabel?: string;
  caption?: string;
  selected: boolean;
  onPress: () => void;
  tooltip?: string;
  size: "m" | "l" | "icon";
  children: ReactNode;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const icon = size === "icon";
  return (
    <View {...hoverProps} style={icon ? { width: pictureChoice.iconWidth } : { flex: 1 }}>
      <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} tooltip={tooltip} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={caption}>
        <Box gap="m" style={{ alignItems: "center" }}>
          <Animated.View style={[icon ? { width: pictureChoice.icon } : { width: "100%" }, scaleStyle]}>
            <SelectableCard
              selected={selected}
              hovered={hovered}
              fill={false}
              radius={icon ? "sheet" : "panel"}
              style={icon ? { width: pictureChoice.icon, height: pictureChoice.icon, alignItems: "center", justifyContent: "center" } : { width: "100%", height: pictureChoice[size], flexDirection: "row" }}
            >
              {children}
            </SelectableCard>
          </Animated.View>
          <Box gap="xxs" style={LABELS}>
            <Box row gap="xs" style={{ alignItems: "center" }}>
              {selected && <Symbol name="checkmark.circle.fill" size={12} color={theme.formAccent} style={CHECK} />}
              <Text size="small" tone={selected ? "textPrimary" : "textSecondary"} lines={1}>
                {title}
              </Text>
            </Box>
            {caption ? (
              <Text size="caption" tone="textTertiary" lines={2} style={CAPTION}>
                {caption}
              </Text>
            ) : null}
          </Box>
        </Box>
      </Pressable>
    </View>
  );
}
