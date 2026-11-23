import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Checkbox, checkboxA11y, IconTile, Radio, radioA11y, spaceActivates, Text, useClosing, useHover, useLiveAction, tapActivates } from "../ui";
import { radius, space } from "../ui/tokens";
import { ChoiceCard } from "./ChoiceCard";
import { useOnboardingColors } from "./Parts";
import { usePressScaleMotion } from "../ui/motion";

const DISABLED_OPACITY = 0.5;
const RADIO_MIN_HEIGHT = 56;

export function OptionCard({
  title,
  subtitle,
  icon,
  control,
  selected,
  onPress,
  disabled,
  onHover,
  preview,
  dense,
  subtitleLines = 2,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  control: "radio" | "check";
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  onHover?: (hovered: boolean) => void;
  preview?: ReactNode;
  dense?: boolean;
  subtitleLines?: number;
}) {
  const colors = useOnboardingColors();
  const { hovered, hoverProps } = useHover();
  const closing = useClosing();
  const live = useLiveAction();
  const pressMotion = usePressScaleMotion(!disabled, preview ? 0.98 : 0.99);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onHover?.(hovered);
  }, [hovered]);

  if (control === "check")
    return (
      <View {...hoverProps} style={{ opacity: disabled ? DISABLED_OPACITY : 1 }}>
        <Pressable
          disabled={disabled || closing}
          focusable={!disabled && !closing}
          onPress={live(onPress)} onAccessibilityTap={disabled || closing ? undefined : tapActivates(live(onPress))}
          onPressIn={pressMotion.onPressIn}
          onPressOut={pressMotion.onPressOut}
          onKeyDown={disabled ? undefined : live(spaceActivates(onPress))}
          {...checkboxA11y(selected, disabled, title)}
        >
          <Animated.View style={scaleStyle}>
            <ChoiceCard
              mouseDownCanMoveWindow={false}
              radius={radius.panel}
              hovered={hovered && !disabled}
              raised={false}
              style={{ flexDirection: "row", alignItems: "center", gap: space.l, paddingVertical: space.m, paddingHorizontal: space.l }}
            >
              {icon ? <IconTile symbol={icon} size="m" fill={colors.iconContainer} glyph={colors.title} /> : null}
              <View style={{ flex: 1, gap: space.xxs }}>
                <Text weight="medium" color={colors.title}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text size="small" lines={subtitleLines} color={colors.rowSubtitle}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <View pointerEvents="none">
                <Checkbox look="ring" size="m" value={selected} />
              </View>
            </ChoiceCard>
          </Animated.View>
        </Pressable>
      </View>
    );

  if (preview)
    return (
      <View {...hoverProps} style={{ flex: 1 }}>
        <Pressable disabled={closing} focusable={!closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} onKeyDown={live(spaceActivates(onPress))} {...radioA11y(selected, title)}>
          <Animated.View style={scaleStyle}>
            <ChoiceCard mouseDownCanMoveWindow={false} radius={radius.panel} selected={selected} hovered={hovered} style={{ padding: space.ml, gap: space.ml }}>
              {preview}
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.m }}>
                <Radio on={selected} look="ring" />
                <View style={{ flex: 1 }}>
                  <Text size="small" weight="medium" color={colors.title}>
                    {title}
                  </Text>
                  {subtitle ? (
                    <Text size="caption" color={colors.rowSubtitle}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
              </View>
            </ChoiceCard>
          </Animated.View>
        </Pressable>
      </View>
    );

  return (
    <View {...hoverProps}>
      <Pressable disabled={closing} focusable={!closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} onKeyDown={live(spaceActivates(onPress))} {...radioA11y(selected, title)}>
        <Animated.View style={scaleStyle}>
          <ChoiceCard
            mouseDownCanMoveWindow={false}
            radius={radius.panel}
            selected={selected}
            hovered={hovered}
            outline="soft"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.l,
              minHeight: dense ? undefined : RADIO_MIN_HEIGHT,
              paddingVertical: space.ml,
              paddingHorizontal: dense ? space.l : space.xl,
            }}
          >
            <Radio on={selected} look="ring" />
            <View style={{ flex: 1, gap: space.xxs }}>
              <Text weight="medium" color={colors.title}>
                {title}
              </Text>
              {subtitle ? (
                <Text size="small" lines={2} color={colors.rowSubtitle}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </ChoiceCard>
        </Animated.View>
      </Pressable>
    </View>
  );
}
