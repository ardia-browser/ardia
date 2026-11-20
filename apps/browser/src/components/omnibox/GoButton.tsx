import type { Suggestion } from "@ardia/core";
import { memo } from "react";
import { Animated, Pressable, View } from "react-native";
import { Symbol, Text, useHover, useTheme } from "../ui";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { BAR_TYPE, GO_BUTTON } from "./tokens";
import { submitAction, type ReturnAction } from "./submitAction";

export function destinationLabel(s: Suggestion | undefined): string {
  if (s?.kind === "search") return s.engine;
  if (s?.kind === "calc") return "Copy";
  return "Go";
}

export function submitButton({ hero, current, rowShown, action, onPress }: { hero: boolean; current: Suggestion | undefined; rowShown: boolean; action: ReturnAction; onPress(): void }) {
  const state = submitAction({ hero, action, rowShown });
  return state.shown ? <GoButton label={destinationLabel(current)} enabled={state.enabled} returnCue={state.returnCue} onPress={onPress} /> : null;
}

export const GoButton = memo(function GoButton({ label, enabled, returnCue, onPress }: { label: string; enabled: boolean; returnCue: boolean; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(enabled, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const primary = enabled && returnCue;
  const tone = primary ? "onPrimary" : enabled ? "textPrimary" : "textSecondary";
  const text = theme[tone];
  return (
    <View {...hoverProps} style={{ marginLeft: GO_BUTTON.before }}>
      <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} disabled={!enabled} accessibilityRole="button" accessibilityLabel={label}>
        <Animated.View
          style={[{
            minWidth: GO_BUTTON.minWidth,
            height: GO_BUTTON.height,
            paddingHorizontal: GO_BUTTON.padX,
            borderRadius: GO_BUTTON.radius,
            backgroundColor: primary ? theme.goButton : enabled && hovered ? theme.rowHover : undefined,
            borderWidth: primary ? 0 : GO_BUTTON.idleBorder,
            borderColor: theme.chipBorder,
            opacity: primary && hovered ? GO_BUTTON.hoverOpacity : 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: GO_BUTTON.gap,
          }, scaleStyle]}
        >
          <Text lines={1} weight="semibold" tone={tone} style={BAR_TYPE.goLabel}>
            {label}
          </Text>
          {returnCue ? (
            <Symbol
              name="return"
              size={GO_BUTTON.glyph}
              weight="medium"
              color={enabled ? text + GO_BUTTON.glyphAlpha : text}
              style={{ width: GO_BUTTON.glyphBox, height: GO_BUTTON.glyphBox }}
            />
          ) : null}
        </Animated.View>
      </Pressable>
    </View>
  );
});
