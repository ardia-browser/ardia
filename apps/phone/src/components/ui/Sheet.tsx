import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ScrollViewProps, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedRef,
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
import { halfSheetPosition, sheetDetentAfterDrag, sheetHalfRest } from "../../lib/sheetDetent";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCoverFocus } from "./coverFocus";
import { reducedMotionMs, tabsCurve, tabsMotion, trayMotion } from "./motion";
import { useTheme } from "./theme";
import { menuLayout, sheetInk } from "./tokens";
import { useReduceMotion, useScreenReader } from "./contrast";
import { MenuFrostProvider } from "./Menu";
import { useDesign } from "./design";
import { MaterialSheet } from "./MaterialSurfaces";
import { FabricCatchUp } from "./FabricCatchUp";

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

export type SheetScroll = { native: ReturnType<typeof Gesture.Native>; atTop: SharedValue<boolean>; scrolls: SharedValue<boolean>; locked?: boolean };

export const SheetScrollContext = createContext<SheetScroll | null>(null);

export function SheetScrollView({ children, onLayout, onContentSizeChange, scrollEnabled, ...rest }: ScrollViewProps) {
  const sheet = useContext(SheetScrollContext);
  const [frame, setFrame] = useState({ view: 0, content: 0 });
  const listRef = useAnimatedRef<Animated.ScrollView>();
  const locked = sheet?.locked ?? false;
  useEffect(() => {
    if (!locked || !sheet) return;
    listRef.current?.scrollTo({ y: 0, animated: true });
    sheet.atTop.value = true;
  }, [locked]);
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
      ref={listRef}
      scrollEnabled={locked ? false : scrollEnabled}
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
  halfOpen?: boolean;
  onExpand?: () => void;
  children: ReactNode;
};

export function Sheet(props: Props) {
  return useDesign() === "material" ? <MaterialSheet open={props.open} onDismiss={props.onDismiss} onTapAway={props.onTapAway} onBack={props.onBack} onHidden={props.onHidden}>{props.children}</MaterialSheet> : <ClassicSheet {...props} />;
}

function ClassicSheet({ open, onDismiss, onHidden, fill, onTapAway, halfOpen = false, onExpand, children }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const shown = useSharedValue(0);
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  const sheetHeight = useSharedValue(height);
  const drag = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  const screenReader = useScreenReader();
  const atTop = useSharedValue(true);
  const scrolls = useSharedValue(false);
  const native = useMemo(() => Gesture.Native(), []);
  const settled = sheetMaxHeight(height, insets.top);
  const halfRestNow = halfOpen && !screenReader ? sheetHalfRest(settled, height) : 0;
  const halfRest = useSharedValue(halfRestNow);
  const rest = useSharedValue(halfRestNow);
  const startedFull = useSharedValue(halfRestNow === 0);
  const [full, setFull] = useState(halfRestNow === 0);
  const scroll = useMemo<SheetScroll>(() => ({ native, atTop, scrolls, locked: !full }), [native, full]);
  const reached = (nowFull: boolean) => {
    setFull(nowFull);
    if (nowFull) onExpand?.();
  };
  useEffect(() => {
    halfRest.value = halfRestNow;
    if (!full || halfRestNow === 0) {
      cancelAnimation(rest);
      rest.value = halfRestNow;
      setFull(halfRestNow === 0);
    }
  }, [halfRestNow]);
  useEffect(() => {
    if (open) {
      drag.value = 0;
      cancelAnimation(rest);
      rest.value = halfRest.value;
      setFull(halfRest.value === 0);
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
    .onBegin(() => {
      cancelAnimation(rest);
      startedFull.value = rest.value <= AT_TOP_SLOP;
    })
    .onUpdate((event) => {
      if (halfRest.value === 0 || startedFull.value) {
        drag.value = sheetPullOffset(event.translationY, scrolls.value, atTop.value);
        return;
      }
      drag.value = halfSheetPosition(rest.value, event.translationY) - rest.value;
    })
    .onEnd((event) => {
      if (halfRest.value > 0) {
        if (startedFull.value && scrolls.value && drag.value <= 0) return;
        const position = rest.value + drag.value;
        const target = sheetDetentAfterDrag(position, event.velocityY, halfRest.value, sheetHeight.value - halfRest.value);
        if (target === "dismiss") {
          runOnJS(onDismiss)();
          return;
        }
        const to = target === "full" ? 0 : halfRest.value;
        rest.value = position;
        drag.value = 0;
        rest.value = reduceMotion ? withTiming(to, { duration: SHEET_REDUCED_MS, easing: tabsCurve.easeOut }) : withSpring(to, trayMotion.settle);
        if ((to === 0) !== startedFull.value) runOnJS(reached)(to === 0);
        return;
      }
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
        clampedProgress(rest.value + drag.value - halfRest.value, menuLayout.sheetRadius * DIM_TRAVEL_RADII)),
  }));
  const slide = useAnimatedStyle(() => ({
    transform: [
      { translateY: (1 - shown.value) * sheetHeight.value + rest.value + drag.value },
    ],
  }));
  const sheetMotionNow = () => {
    "worklet";
    return (1 - shown.value) * sheetHeight.value + rest.value + drag.value;
  };
  const grabber = menuLayout.sheetGrabber ?? (halfOpen ? menuLayout.halfSheetGrabber : null);
  const grabberRoom = menuLayout.sheetGrabber ? 0 : grabber ? grabber.top + grabber.height : 0;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={open ? "box-none" : "none"} collapsable={false}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      accessibilityElementsHidden={!open}
    >
      {open ? <FabricCatchUp motion={sheetMotionNow} testID="sheetFabricCatchUp" /> : null}
      <Animated.View style={[StyleSheet.absoluteFill, dim]}>
        <Pressable
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.trayDim }]}
          onPress={() => {
            if (menuLayout.sheetGrabber) onTapAway?.();
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
              ...(halfOpen ? { height: settled } : { maxHeight: settled }),
              paddingTop: grabberRoom,
              left: insets.left,
              right: insets.right,
              paddingBottom: insets.bottom,
              shadowColor: theme.trayShadow,
            },
            slide,
          ]}
        >
          <View testID="sheetFill" style={[StyleSheet.absoluteFill, { backgroundColor: fill ?? (theme.dark ? sheetInk.fill.dark : sheetInk.fill.light) }]} />
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
