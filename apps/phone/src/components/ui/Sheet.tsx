import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  clampedProgress,
  trayDragDismisses,
  trayDragOffset,
} from "../../lib/trayMotion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCoverFocus } from "./coverFocus";
import { LookBackdrop } from "./LookViews";
import { reducedMotionMs, tabsCurve, tabsMotion, trayMotion } from "./motion";
import { useTheme } from "./theme";
import { menuLayout } from "./tokens";
import { useReduceMotion } from "./contrast";

const SHEET_REDUCED_MS = reducedMotionMs(trayMotion.reduced);

const HIDE_FALLBACK_MS = 900;
const DIM_TRAVEL_RADII = 8;

export function usePresence(open: boolean): {
  mounted: boolean;
  hidden: () => void;
} {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return { mounted: open || mounted, hidden: () => setMounted(false) };
}

type Props = {
  open: boolean;
  onDismiss: () => void;
  onHidden: () => void;
  fill?: string;
  children: ReactNode;
};

export function Sheet({ open, onDismiss, onHidden, fill, children }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const shown = useSharedValue(0);
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  const sheetHeight = useSharedValue(height);
  const drag = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (open) {
      drag.value = 0;
      shown.value = reduceMotion
        ? withTiming(1, {
            duration: SHEET_REDUCED_MS,
            easing: tabsCurve.easeOut,
          })
        : withSpring(1, tabsMotion.sheetIn);
      return;
    }
    const hidden = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onHidden)();
    };
    shown.value = reduceMotion
      ? withTiming(
          0,
          { duration: SHEET_REDUCED_MS, easing: tabsCurve.easeInOut },
          hidden,
        )
      : withSpring(0, tabsMotion.sheetOut, hidden);
    const fallback = setTimeout(onHidden, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [open]);
  const pull = Gesture.Pan()
    .withTestId("sheetDrag")
    .enabled(open)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .onUpdate((event) => {
      drag.value = trayDragOffset(event.translationY);
    })
    .onEnd((event) => {
      if (
        trayDragDismisses(
          event.translationY,
          event.velocityY,
          sheetHeight.value,
        )
      ) {
        runOnJS(onDismiss)();
        return;
      }
      drag.value = reduceMotion
        ? withTiming(0, {
            duration: SHEET_REDUCED_MS,
            easing: tabsCurve.easeOut,
          })
        : withSpring(0, trayMotion.settle);
    });
  const dim = useAnimatedStyle(() => ({
    opacity:
      Math.min(Math.max(shown.value, 0), 1) *
      (1 -
        clampedProgress(drag.value, menuLayout.sheetRadius * DIM_TRAVEL_RADII)),
  }));
  const slide = useAnimatedStyle(() => ({
    transform: [
      { translateY: (1 - shown.value) * sheetHeight.value + drag.value },
    ],
  }));
  const settled = Math.max(height - insets.top - menuLayout.sheetTopGap, 0);
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={open ? "box-none" : "none"} collapsable={false}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      accessibilityElementsHidden={!open}
    >
      <Animated.View style={[StyleSheet.absoluteFill, dim]}>
        <Pressable
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.trayDim }]}
          onPress={onDismiss}
        />
      </Animated.View>
      <GestureDetector gesture={pull}>
        <Animated.View
          ref={panel}
          accessibilityViewIsModal
          onLayout={(event) => {
            sheetHeight.value = event.nativeEvent.layout.height;
          }}
          style={[
            styles.sheet,
            {
              maxHeight: settled,
              left: insets.left,
              right: insets.right,
              paddingBottom: insets.bottom,
              shadowColor: theme.trayShadow,
            },
            slide,
          ]}
        >
          {fill ? <View testID="sheetFill" style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} /> : <LookBackdrop />}
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    borderTopLeftRadius: menuLayout.sheetRadius,
    borderTopRightRadius: menuLayout.sheetRadius,
    elevation: 12,
  },
});
