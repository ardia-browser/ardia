import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { rowDeletes, rowOffset } from "../../lib/sheetDrag";
import { tabsMotion } from "./motion";
import { Symbol } from "./Symbol";
import { useTheme } from "./theme";
import { font, ink, space, swipeDeleteLayout } from "./tokens";
import { usePressStyle } from "./pressFeedback";

export function SwipeToDelete({ onDelete, revealsOnly = false, children }: { onDelete: () => void; revealsOnly?: boolean; children: ReactNode }) {
  const theme = useTheme();
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-swipeDeleteLayout.slop, swipeDeleteLayout.slop])
        .failOffsetY([-swipeDeleteLayout.slop, swipeDeleteLayout.slop])
        .onUpdate((event) => {
          x.value = rowOffset(event.translationX);
        })
        .onEnd((event) => {
          if (revealsOnly) {
            x.value = withSpring(event.translationX < -swipeDeleteLayout.revealWidth / 2 ? -swipeDeleteLayout.revealWidth : 0, tabsMotion.settle);
            return;
          }
          if (rowDeletes(event.translationX, event.velocityX)) {
            x.value = withTiming(-width.value, { duration: tabsMotion.flyAway }, (finished) => {
              if (finished) runOnJS(onDelete)();
            });
          } else x.value = withSpring(0, tabsMotion.settle);
        }),
    [onDelete, revealsOnly],
  );
  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const under = useAnimatedStyle(() => ({ opacity: x.value < 0 ? 1 : 0 }));
  const revealStyle = usePressStyle("text", { style: styles.reveal });
  return (
    <GestureDetector gesture={swipe}>
      <View
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, styles.under, { backgroundColor: theme.destructive }, under]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {revealsOnly ? (
            <Pressable
              onPress={() => {
                x.value = withTiming(-width.value, { duration: tabsMotion.flyAway }, (finished) => {
                  if (finished) runOnJS(onDelete)();
                });
              }}
              style={revealStyle}
            >
              <Text style={styles.revealText}>Delete</Text>
            </Pressable>
          ) : (
            <Symbol name="trash" size={swipeDeleteLayout.glyph} color={ink.white} />
          )}
        </Animated.View>
        <Animated.View style={row}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  under: { alignItems: "flex-end", justifyContent: "center", paddingHorizontal: space.xl },
  reveal: { position: "absolute", right: 0, top: 0, bottom: 0, width: swipeDeleteLayout.revealWidth, alignItems: "center", justifyContent: "center" },
  revealText: { ...font.body, color: ink.white, fontWeight: "600" },
});
