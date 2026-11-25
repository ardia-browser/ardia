import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type AccessibilityActionEvent, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { keyboardIsUp } from "../../lib/trayMotion";
import { useBottomLift } from "../search/useKeyboardHeight";
import { useSurface } from "../../state/browse/hooks";
import { useDeckBarTop, useToast } from "../../state/toasts/hooks";
import { pageBarClearance, TOAST_MOTION, toastDragDismisses, toastPlace, type ToastPlacement } from "../../state/toasts/placement";
import { dismissesToast, toastAnnouncement, toastDragReturn, toastSemantics, toastSpokenLabel } from "../../state/toasts/semantics";
import { dismissToast, holdToast, tapToast, type ToastIcon } from "../../state/toasts/store";
import { ChromeSurface, font, space, stroke, Symbol, tabsMotion, toastLayout, toastMotion, useDesign, usePressStyle, useTheme, type SymbolName, useReduceMotion } from "../ui";
import { toastGesture } from "./toastTokens";
import { materialBottomBar } from "../ui/materialTokens";
import { IncognitoLook } from "../ui/theme";
import { useIncognito } from "../../state/tabs/hooks";

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
  swipe: "handDrawFill",
};

export function ToastHost() {
  const material = useDesign() === "material";
  const incognito = useIncognito();
  return (
    <IncognitoLook value={incognito && !material}>
      <ToastLayer />
    </IncognitoLook>
  );
}

type ToastSpot = ToastPlacement & { safeTop: number };

function ToastLayer() {
  const insets = useSafeAreaInsets();
  const surface = useSurface();
  const barTop = useDeckBarTop();
  const material = useDesign() === "material";
  const frame = useRef<ViewInstance>(null);
  const [hostBottom, setHostBottom] = useState(0);
  const spot: ToastSpot = {
    safeTop: insets.top,
    keyboardLift: null,
    safeBottom: insets.bottom,
    barClearance: pageBarClearance(material ? materialBottomBar : null, toastLayout.barClearance, space.s),
    hostBottomY: hostBottom,
    barTopY: surface === "browsing" ? null : barTop,
    gap: space.s,
  };
  return (
    <View
      ref={frame}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={() => frame.current?.measureInWindow((_x, y, _width, height) => setHostBottom(y + height))}
    >
      <ToastView spot={spot} />
    </View>
  );
}

function useKeyboardRide(spot: ToastSpot, resting: number, arrivedOverKeyboard: boolean, keyboardHeight: SharedValue<number>) {
  const screenHeight = useWindowDimensions().height;
  const belowHost = spot.hostBottomY > 0 ? Math.max(0, screenHeight - spot.hostBottomY) : 0;
  return useAnimatedStyle(() => {
    if (arrivedOverKeyboard) return { transform: [{ translateY: 0 }] };
    const above = keyboardHeight.value - belowHost + spot.gap;
    return { transform: [{ translateY: -Math.max(0, above - resting) }] };
  }, [arrivedOverKeyboard, belowHost, resting, spot.gap]);
}

type PlaceProps = { spot: ToastSpot; toastId: number; children: ReactNode };

function KeyboardRidingPlace({ spot, toastId, children }: PlaceProps) {
  const keyboard = useAnimatedKeyboard();
  const keyboardNow = () => Math.max(keyboard.height.value, Keyboard.isVisible() ? (Keyboard.metrics()?.height ?? 0) : 0);
  const [arrival, setArrival] = useState(() => ({ toastId, overKeyboard: keyboardIsUp(keyboardNow()) }));
  if (arrival.toastId !== toastId) setArrival({ toastId, overKeyboard: keyboardIsUp(keyboardNow()) });
  const arrivedOverKeyboard = arrival.toastId === toastId ? arrival.overKeyboard : keyboardIsUp(keyboardNow());
  const place = toastPlace({ ...spot, keyboardLift: arrivedOverKeyboard ? keyboardNow() : null });
  const resting = "bottom" in place ? place.bottom : 0;
  const ride = useKeyboardRide(spot, resting, arrivedOverKeyboard, keyboard.height);
  return (
    <Animated.View testID="toastPlace" style={[styles.host, place, ride]} pointerEvents="box-none">
      {children}
    </Animated.View>
  );
}

function ResizedPlace({ spot, children }: PlaceProps) {
  const { lift, keyboard } = useBottomLift();
  return (
    <View testID="toastPlace" style={[styles.host, toastPlace({ ...spot, keyboardLift: keyboard ? lift : null })]} pointerEvents="box-none">
      {children}
    </View>
  );
}

const ToastPlace = Platform.OS === "ios" ? KeyboardRidingPlace : ResizedPlace;

function ToastView({ spot }: { spot: ToastSpot }) {
  const toast = useToast();
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const drag = useSharedValue(0);
  const actionLabel = toast?.action?.label ?? null;
  const semantics = toastSemantics(actionLabel, Platform.OS);
  useEffect(() => {
    drag.value = 0;
    if (toast && semantics.announcement === "announceForAccessibility") AccessibilityInfo.announceForAccessibility(toastAnnouncement(toast.message, actionLabel));
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
          drag.value = toastDragReturn(reduceMotion) === "snap" ? 0 : withSpring(0, toastMotion.snappy);
        }),
    [reduceMotion],
  );
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(drag.value, drag.value / 4) }] }));
  const pressStyle = usePressStyle("filled", { style: styles.press });
  if (!toast) return null;
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (dismissesToast(event.nativeEvent.actionName)) dismissToast();
  };
  const escape = semantics.escapes ? dismissToast : undefined;
  const content = (
    <ToastPlate>
      <Symbol name={ICONS[toast.icon]} size={toastLayout.iconSize} color={theme.toastLabel} />
      <Text style={[font.subheadline, styles.text, { color: theme.toastLabel }]} numberOfLines={3}>
        {toast.message}
      </Text>
      {actionLabel !== null ? <Text testID="toastAction" style={[font.subheadline, styles.action, { color: theme.toastLabel }]}>{actionLabel}</Text> : null}
    </ToastPlate>
  );
  return (
    <ToastPlace spot={spot} toastId={toast.id}>
      <GestureDetector gesture={gesture}>
        <Animated.View key={toast.id} entering={reduceMotion ? REDUCED_IN : toastIn} exiting={reduceMotion ? REDUCED_OUT : toastOut} style={[styles.origin, dragged]}>
          {semantics.pressable ? (
            <Pressable testID="toast" accessibilityRole="button" accessibilityLabel={toastSpokenLabel(toast.message, actionLabel)} accessibilityLiveRegion={semantics.liveRegion} accessibilityActions={semantics.actions} onAccessibilityAction={onAccessibilityAction} onAccessibilityEscape={escape} onPress={tapToast} style={pressStyle}>
              {content}
            </Pressable>
          ) : (
            <View testID="toast" accessible accessibilityRole="alert" accessibilityLabel={toast.message} accessibilityLiveRegion={semantics.liveRegion} accessibilityActions={semantics.actions} onAccessibilityAction={onAccessibilityAction} onAccessibilityEscape={escape} style={styles.press}>
              {content}
            </View>
          )}
        </Animated.View>
      </GestureDetector>
    </ToastPlace>
  );
}

function ToastPlate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  if (useDesign() === "material") return <View testID="toastPlate" style={[styles.toast, styles.materialPlate, { backgroundColor: theme.toastFill, borderColor: theme.panelBorder, shadowColor: theme.toastShadow, borderRadius: toastLayout.radius }]}>{children}</View>;
  return (
    <ChromeSurface testID="toastPlate" shape="rounded" cornerRadius={toastLayout.radius} interactive={false} barShadow style={styles.toast}>
      {children}
    </ChromeSurface>
  );
}

const TOAST_SLOP = toastGesture.slop;
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
  press: { borderRadius: toastLayout.radius, borderCurve: "continuous" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    minHeight: toastLayout.minHeight,
    paddingHorizontal: space.l,
    paddingVertical: toastLayout.verticalPadding,
    borderCurve: "continuous",
  },
  materialPlate: { borderWidth: stroke.hairline, shadowOpacity: 1, shadowRadius: toastLayout.shadowRadius, shadowOffset: { width: 0, height: toastLayout.shadowY }, elevation: toastGesture.materialElevation },
  text: { fontWeight: "600", flexShrink: 1 },
  action: { fontWeight: "700" },
});
