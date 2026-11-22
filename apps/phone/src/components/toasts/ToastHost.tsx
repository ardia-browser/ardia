import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomLift } from "../search/useKeyboardHeight";
import { useSurface } from "../../state/browse/hooks";
import { useDeckBarTop, useToast } from "../../state/toasts/hooks";
import { pageBarClearance, TOAST_MOTION, toastDragDismisses, toastPlace } from "../../state/toasts/placement";
import { dismissToast, holdToast, tapToast, type ToastIcon } from "../../state/toasts/store";
import { font, space, Symbol, tabsMotion, toastLayout, toastMotion, useDesign, useTheme, type SymbolName, useReduceMotion } from "../ui";
import { materialBottomBar } from "../ui/materialTokens";

const ICONS: Record<ToastIcon, SymbolName> = {
  checkmark: "checkmark",
  warning: "exclamationmarkTriangleFill",
  download: "arrowDownCircleFill",
  blocking: "handRaised",
  link: "link",
  laptop: "laptop",
  star: "starFill",
  sent: "paperplane",
  calculation: "equalCircleFill",
  iphone: "iphone",
};

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const { lift, keyboard } = useBottomLift();
  const surface = useSurface();
  const barTop = useDeckBarTop();
  const material = useDesign() === "material";
  const frame = useRef<ViewInstance>(null);
  const [hostBottom, setHostBottom] = useState(0);
  const place = toastPlace({
    safeTop: insets.top,
    keyboardLift: keyboard ? lift : null,
    safeBottom: insets.bottom,
    barClearance: pageBarClearance(material ? materialBottomBar : null, toastLayout.barClearance, space.s),
    hostBottomY: hostBottom,
    barTopY: surface === "browsing" ? null : barTop,
    gap: space.s,
  });
  return (
    <View
      ref={frame}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={() => frame.current?.measureInWindow((_x, y, _width, height) => setHostBottom(y + height))}
    >
      <ToastView place={place} />
    </View>
  );
}

function ToastView({ place }: { place: { top: number } | { bottom: number } }) {
  const toast = useToast();
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const drag = useSharedValue(0);
  useEffect(() => {
    drag.value = 0;
    if (toast && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(toast.message);
  }, [toast?.id]);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-TOAST_SLOP, TOAST_SLOP])
        .onStart(() => {
          runOnJS(holdToast)(true);
        })
        .onUpdate((event) => {
          drag.value = event.translationY;
        })
        .onEnd((event) => {
          if (toastDragDismisses(event.translationY, event.velocityY)) {
            runOnJS(dismissToast)();
            return;
          }
          runOnJS(holdToast)(false);
          drag.value = withSpring(0, toastMotion.snappy);
        }),
    [],
  );
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(drag.value, drag.value / 4) }] }));
  if (!toast) return null;
  return (
    <View style={[styles.host, place]} pointerEvents="box-none">
      <GestureDetector gesture={gesture}>
        <Animated.View key={toast.id} entering={reduceMotion ? REDUCED_IN : toastIn} exiting={reduceMotion ? REDUCED_OUT : toastOut} style={[styles.origin, dragged]}>
          <Pressable
            accessibilityRole={toast.onTap ? "button" : "alert"}
            accessibilityLiveRegion="polite"
            onPress={tapToast}
            style={[
              styles.toast,
              { backgroundColor: theme.toastFill, borderColor: theme.panelBorder, shadowColor: theme.toastShadow, borderRadius: toastLayout.radius },
            ]}
          >
            <Symbol name={ICONS[toast.icon]} size={toastLayout.iconSize} color={theme.toastLabel} />
            <Text style={[font.subheadline, styles.text, { color: theme.toastLabel }]} numberOfLines={3}>
              {toast.message}
            </Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const TOAST_SLOP = 8;
const REDUCED_IN = FadeIn.duration(tabsMotion.surfaceFade);
const REDUCED_OUT = FadeOut.duration(tabsMotion.surfaceFade);

const toastIn = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: TOAST_MOTION.enterTravel }, { scale: TOAST_MOTION.enterScale }] },
    animations: {
      opacity: withSpring(1, toastMotion.snappy),
      transform: [{ translateY: withSpring(0, toastMotion.snappy) }, { scale: withSpring(1, toastMotion.snappy) }],
    },
  };
};

const toastOut = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: { opacity: withSpring(0, toastMotion.snappy), transform: [{ translateY: withSpring(TOAST_MOTION.exitTravel, toastMotion.snappy) }] },
  };
};

const styles = StyleSheet.create({
  host: { position: "absolute", left: toastLayout.sideInset, right: toastLayout.sideInset, alignItems: "center" },
  origin: { transformOrigin: "50% 100%" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    minHeight: toastLayout.minHeight,
    paddingHorizontal: space.l,
    paddingVertical: toastLayout.verticalPadding,
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: "continuous",
    shadowOpacity: 1,
    shadowRadius: toastLayout.shadowRadius,
    shadowOffset: { width: 0, height: toastLayout.shadowY },
    elevation: 8,
  },
  text: { fontWeight: "600", flexShrink: 1 },
});
