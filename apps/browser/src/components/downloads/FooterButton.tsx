import { Animated, Pressable, View } from "react-native";
import { HoverFill, menuRowFill, PANEL, Symbol, Text, useClosing, useGlass, useHover, useLiveAction, useTheme, tapActivates } from "../ui";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { DOWNLOADS_LIST } from "./tokens";

export function FooterButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  const glass = useGlass();
  const { hovered, hoverProps } = useHover();
  const closing = useClosing();
  const live = useLiveAction();
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  return (
    <View {...hoverProps} style={{ paddingHorizontal: PANEL.rowInset }}>
      <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button">
        {({ pressed }) => (
          <Animated.View
            style={[{
              height: PANEL.rowHeight,
              paddingHorizontal: PANEL.rowPadding,
              borderRadius: PANEL.rowRadius,
              flexDirection: "row",
              alignItems: "center",
            }, scaleStyle]}
          >
            <HoverFill shown={hovered || pressed} instant={pressed} color={menuRowFill(theme, pressed)} radius={PANEL.rowRadius} glass={glass ? (pressed ? "pressed" : "lit") : undefined} />
            <Text tone={hovered ? "textPrimary" : "textSecondary"} style={{ flex: 1 }}>
              {title}
            </Text>
            <Symbol
              name="chevron.right"
              size={DOWNLOADS_LIST.chevronSize}
              weight="semibold"
              color={theme.textTertiary}
              style={{ width: DOWNLOADS_LIST.chevronBox, height: DOWNLOADS_LIST.chevronBox, marginRight: -DOWNLOADS_LIST.chevronBearing }}
            />
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
}
