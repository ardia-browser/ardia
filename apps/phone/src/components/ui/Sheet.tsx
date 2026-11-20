import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ScrollViewProps, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
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
import { MenuFrostProvider } from "./Menu";
import { useDesign } from "./design";
import { MaterialSheet } from "./MaterialSurfaces";

const SHEET_REDUCED_MS = reducedMotionMs(trayMotion.reduced);

const HIDE_FALLBACK_MS = 900;
const DIM_TRAVEL_RADII = 8;
const AT_TOP_SLOP = 0.5;

export const sheetMaxHeight = (height: number, safeTop: number) => Math.max(height - safeTop - menuLayout.sheetTopGap, 0);

export const sheetPullTranslation = (translationY: number, scrolls: boolean, atTop: boolean) => {
  "worklet";
  if (!scrolls) return translationY;
  return atTop && translationY > 0 ? translationY : 0;
};

export const sheetPullOffset = (translationY: number, scrolls: boolean, atTop: boolean) => {
  "worklet";
  return trayDragOffset(sheetPullTranslation(translationY, scrolls, atTop));
};

export type SheetScroll = { native: ReturnType<typeof Gesture.Native>; atTop: SharedValue<boolean>; scrolls: SharedValue<boolean> };

export const SheetScrollContext = createContext<SheetScroll | null>(null);

export function SheetScrollView({ children, onLayout, onContentSizeChange, ...rest }: ScrollViewProps) {
  const sheet = useContext(SheetScrollContext);
  const [frame, setFrame] = useState({ view: 0, content: 0 });
  useEffect(() => {
    if (sheet) sheet.scrolls.value = frame.content > frame.view + AT_TOP_SLOP;
  }, [sheet, frame]);
  useEffect(
    () => () => {
      if (sheet) sheet.scrolls.value = false;
    },
    [sheet],
  );
  const onScroll = useAnimatedScrollHandler((event) => {
    if (sheet) sheet.atTop.value = event.contentOffset.y <= AT_TOP_SLOP;
  });
  const list = (
    <Animated.ScrollView
      {...rest}
      scrollEventThrottle={16}
      onScroll={onScroll}
      onLayout={(event) => {
        onLayout?.(event);
        const view = event.nativeEvent.layout.height;
        setFrame((was) => (was.view === view ? was : { ...was, view }));
      }}
      onContentSizeChange={(width, content) => {
        onContentSizeChange?.(width, content);
        setFrame((was) => (was.content === content ? was : { ...was, content }));
      }}
    >
      {children}
    </Animated.ScrollView>
  );
  return sheet ? <GestureDetector gesture={sheet.native}>{list}</GestureDetector> : list;
}

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
  onBack?: () => void;
  onHidden: () => void;
  fill?: string;
  onTapAway?: () => void;
  children: ReactNode;
};

export function Sheet(props: Props) {
  return useDesign() === "material" ? <MaterialSheet open={props.open} onDismiss={props.onDismiss} onTapAway={props.onTapAway} onBack={props.onBack} onHidden={props.onHidden}>{props.children}</MaterialSheet> : <ClassicSheet {...props} />;
}

function ClassicSheet({ open, onDismiss, onHidden, fill, onTapAway, children }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const shown = useSharedValue(0);
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  const sheetHeight = useSharedValue(height);
  const drag = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  const atTop = useSharedValue(true);
  const scrolls = useSharedValue(false);
  const native = useMemo(() => Gesture.Native(), []);
  const scroll = useMemo<SheetScroll>(() => ({ native, atTop, scrolls }), [native]);
  useEffect(() => {
    if (open) {
      drag.value = 0;
      atTop.value = true;
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
    .simultaneousWithExternalGesture(native)
    .onUpdate((event) => {
      drag.value = sheetPullOffset(event.translationY, scrolls.value, atTop.value);
    })
    .onEnd((event) => {
      if (
        (!scrolls.value || drag.value > 0) &&
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
  const settled = sheetMaxHeight(height, insets.top);
  const grabber = menuLayout.sheetGrabber;
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
          onPress={() => {
            if (grabber) onTapAway?.();
            onDismiss();
          }}
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
          <SheetScrollContext.Provider value={grabber ? scroll : null}>
            <MenuFrostProvider value={null}>{children}</MenuFrostProvider>
          </SheetScrollContext.Provider>
          {grabber ? (
            <View
              testID="sheetGrabber"
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={[styles.grabber, { top: grabber.top, width: grabber.width, height: grabber.height, borderRadius: grabber.height / 2, marginLeft: -grabber.width / 2, backgroundColor: theme.tertiaryLabel }]}
            />
          ) : null}
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
  grabber: { position: "absolute", left: "50%" },
});
