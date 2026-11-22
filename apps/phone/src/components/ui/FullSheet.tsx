import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewInstance, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useCoverFocus } from "./coverFocus";
import { useReduceMotion } from "./contrast";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { backgroundScale, draggedOffset, sheetDismisses, sheetProgress } from "../../lib/sheetDrag";
import { initialPresence, presenceSettled, presenceShown, presenceTarget } from "../../lib/sheetPresence";
import { iPhoneOr, reducedMotionMs, tabsCurve, tabsMotion } from "./motion";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { useTheme } from "./theme";
import { sheetInk, sheetLayout, smoothCorners, tabsLayout } from "./tokens";
import { MenuFrostProvider } from "./Menu";
import { useDesign } from "./design";
import { withAlpha } from "../../lib/color";
import { MATERIAL_STATE } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";
import { materialDuration, materialMotion, materialMove, materialShape } from "./materialTokens";
import { FabricCatchUp } from "./FabricCatchUp";

const SHEET_REDUCED_MS = reducedMotionMs(tabsMotion.sheetReduced);

const HIDE_FALLBACK_MS = 900;
const DRAG_SLOP = 12;

type ListProps = {
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  scrollEventThrottle: number;
};

type SheetFrame = { top: number; list: (refreshesOnPull: boolean) => ListProps };

const SheetFrameContext = createContext<SheetFrame | null>(null);

export const useSheetFrame = (): SheetFrame | null => useContext(SheetFrameContext);

type Props<T extends string> = { sheet: T | null; progress: SharedValue<number>; onDismiss: () => void; children: (shown: T) => ReactNode };

export function FullSheet<T extends string>({ sheet, progress, onDismiss, children }: Props<T>) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const material = useDesign() === "material";
  const { scheme } = useMaterialTheme();
  const presence = useRef(initialPresence(sheet));
  const shown = sheet ?? presenceShown(presence.current);
  const sheetView = useRef<ViewInstance>(null);
  useCoverFocus(sheetView, material && sheet === "settings");
  const top = insets.top + (material && shown !== "settings" ? 0 : iPhoneOr(sheetLayout.iPhoneTopGap, sheetLayout.topGap));
  const bottomCorner = material ? 0 : iPhoneOr(screenCornerRadius(tabsLayout.displayCornerRadius), 0);
  const [, redraw] = useState(0);
  const initialHeight = Math.max(1, window.height - top);
  const height = useSharedValue(initialHeight);
  const offset = useSharedValue(sheet ? 0 : initialHeight);
  const dragFrom = useSharedValue(0);
  const scrollTop = useSharedValue(0);
  const touch = useSharedValue({ x: 0, y: 0, inList: false });
  const listTop = useSharedValue(0);
  const listPulls = useSharedValue(false);
  useEffect(() => {
    height.value = Math.max(1, window.height - top);
  }, [window.height, top]);

  useEffect(() => {
    const step = presenceTarget(presence.current, sheet);
    presence.current = step.presence;
    if (step.motion === "none") return;
    if (step.motion === "in") {
      if (step.fromHidden) offset.value = height.value;
      scrollTop.value = 0;
      if (material) offset.value = materialMove(0, materialMotion.sheetEnter.easing, reduceMotion ? SHEET_REDUCED_MS : materialMotion.sheetEnter.durationMs);
      else offset.value = reduceMotion ? withTiming(0, { duration: SHEET_REDUCED_MS, easing: tabsCurve.easeOut }) : withSpring(0, tabsMotion.sheetRise);
      return;
    }
    const generation = step.presence.generation;
    const settle = (finished: boolean) => {
      const next = presenceSettled(presence.current, generation, finished);
      if (next === presence.current) return;
      presence.current = next;
      redraw((count) => count + 1);
    };
    const settled = (finished?: boolean) => {
      "worklet";
      runOnJS(settle)(finished === true);
    };
    if (material) offset.value = materialMove(height.value, materialMotion.sheetExit.easing, reduceMotion ? SHEET_REDUCED_MS : materialMotion.sheetExit.durationMs, settled);
    else
      offset.value = reduceMotion
        ? withTiming(height.value, { duration: SHEET_REDUCED_MS, easing: tabsCurve.easeInOut }, settled)
        : withSpring(height.value, tabsMotion.sheetDismiss, settled);
    const fallback = setTimeout(() => settle(true), HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [sheet]);

  useAnimatedReaction(
    () => sheetProgress(offset.value, height.value),
    (now) => {
      progress.value = now;
    },
  );

  const drag = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          const first = event.allTouches[0];
          if (first) touch.value = { x: first.absoluteX, y: first.absoluteY, inList: first.absoluteY - top - offset.value >= listTop.value };
        })
        .onTouchesMove((event, manager) => {
          const first = event.allTouches[0];
          if (!first) return;
          const dx = first.absoluteX - touch.value.x;
          const dy = first.absoluteY - touch.value.y;
          if (Math.abs(dx) > DRAG_SLOP && Math.abs(dx) > Math.abs(dy)) manager.fail();
          else if (dy < -DRAG_SLOP) manager.fail();
          else if (dy > DRAG_SLOP && dy > Math.abs(dx)) {
            if (!touch.value.inList || (scrollTop.value <= 0 && !listPulls.value)) manager.activate();
            else manager.fail();
          }
        })
        .onStart(() => {
          dragFrom.value = offset.value;
        })
        .onUpdate((event) => {
          offset.value = draggedOffset(dragFrom.value, event.translationY, height.value);
        })
        .onEnd((event) => {
          if (sheetDismisses(offset.value, height.value, event.velocityY)) runOnJS(onDismiss)();
          else offset.value = material ? materialMove(0, "standard", materialDuration.short4) : withSpring(0, tabsMotion.sheetRise);
        }),
    [onDismiss, top, material],
  );

  const frame = useMemo<SheetFrame>(
    () => ({
      top,
      list: (refreshesOnPull) => ({
        scrollEventThrottle: 16,
        onScroll: (event) => {
          scrollTop.value = event.nativeEvent.contentOffset.y;
        },
        onLayout: (event) => {
          listTop.value = event.nativeEvent.layout.y;
          listPulls.value = refreshesOnPull;
        },
      }),
    }),
    [top],
  );

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const sheetMotionNow = () => {
    "worklet";
    return offset.value;
  };
  if (!shown) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={sheet ? "auto" : "none"} collapsable={false} importantForAccessibility={sheet ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!sheet}>
      {sheet ? <FabricCatchUp motion={sheetMotionNow} testID="fullSheetFabricCatchUp" /> : null}
      <Animated.View style={[StyleSheet.absoluteFill, material ? { backgroundColor: withAlpha(scheme.scrim, MATERIAL_STATE.scrim) } : styles.scrim, scrim]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <GestureDetector gesture={drag}>
        <Animated.View
          ref={sheetView}
          testID="fullSheet"
          accessibilityViewIsModal
          onLayout={(event) => {
            height.value = Math.max(1, event.nativeEvent.layout.height);
          }}
          style={[
            styles.sheet,
            { top, left: insets.left, right: insets.right, borderBottomLeftRadius: bottomCorner, borderBottomRightRadius: bottomCorner },
            material ? { borderTopLeftRadius: materialShape.extraLarge, borderTopRightRadius: materialShape.extraLarge, backgroundColor: scheme.surfaceContainerLow } : null,
            slide,
          ]}
        >
          <SheetFrameContext.Provider value={frame}>
            <MenuFrostProvider value={null}>{children(shown)}</MenuFrostProvider>
          </SheetFrameContext.Provider>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function SheetBackground({ progress, children }: { progress: SharedValue<number>; children: ReactNode }) {
  const theme = useTheme();
  const material = useDesign() === "material";
  const shrink = useAnimatedStyle(() => ({
    transform: [{ scale: material ? 1 : backgroundScale(progress.value) }],
    borderRadius: !material && progress.value > 0 ? sheetLayout.backgroundRadius : 0,
  }));
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.clip, shrink]}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: sheetInk.scrim },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    borderTopLeftRadius: sheetLayout.radius,
    borderTopRightRadius: sheetLayout.radius,
  },
  clip: { overflow: "hidden", ...smoothCorners },
});
