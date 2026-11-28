import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, StyleSheet, Text, useWindowDimensions, View, type AccessibilityActionEvent, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { keyboardIsUp } from "../../lib/trayMotion";
import { backdropIsDark, compositeOver } from "../../lib/readableInk";
import { useBottomLift } from "../search/useKeyboardHeight";
import { useSurface } from "../../state/browse/hooks";
import { useDeckBarTop, usePageBarShown, useToast } from "../../state/toasts/hooks";
import { floatingBarClearance, floatingPillClearance, materialPillClearance, pageBarClearance, shownBarClearance, TOAST_MOTION, toastPlace, toastSideInset, type ToastPlacement } from "../../state/toasts/placement";
import { IDLE_TOAST_TOUCH, toastTouchDown, toastTouchDrag, toastTouchMove, toastTouchUp, type ToastTouch } from "../../state/toasts/touch";
import { FLOATING_BAR_PLACE, floatingBarCenter } from "../../lib/deckGeometry";
import { activatesToast, dismissesToast, toastAnnouncement, toastDragReturn, toastSemantics } from "../../state/toasts/semantics";
import { dismissToast, holdToast, tapToast, type Toast, type ToastAction, type ToastIcon, type ToastTile } from "../../state/toasts/store";
import { browseLayout, chromeLayout, font, PlateSymbol, PlateText, press, space, stroke, SurfaceInkProvider, Symbol, tabsMotion, toastLayout, toastMotion, useDesign, useSurfaceInk, useTheme, type SymbolName, useReduceMotion } from "../ui";
import { fileKindOf, fileTileLabel, toastGesture, toastTileInk } from "./toastTokens";
import { materialBarPill, materialBottomBar } from "../ui/materialTokens";
import { IncognitoLook } from "../ui/theme";
import { useIncognito } from "../../state/tabs/hooks";
import { hostPillLayout } from "../browsing/hostPillTokens";

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

export function ToastHost({ covered = false }: { covered?: boolean }) {
  const material = useDesign() === "material";
  const incognito = useIncognito();
  return (
    <IncognitoLook value={incognito && !material}>
      <ToastLayer covered={covered} />
    </IncognitoLook>
  );
}

type ToastSpot = ToastPlacement & { safeTop: number; side: number };

function ToastLayer({ covered }: { covered: boolean }) {
  const insets = useSafeAreaInsets();
  const surface = useSurface();
  const barTop = useDeckBarTop();
  const pageBar = usePageBarShown();
  const design = useDesign();
  const frame = useRef<ViewInstance>(null);
  const [hostBottom, setHostBottom] = useState(0);
  const gap = space.s;
  const floatingCenter = floatingBarCenter(insets.bottom, Platform.OS);
  const full = design === "redesigned" ? floatingBarClearance(floatingCenter, FLOATING_BAR_PLACE.control, gap, insets.bottom) : design === "material" ? pageBarClearance(materialBottomBar, 0, gap) : toastLayout.barClearance;
  const pill = design === "redesigned" ? floatingPillClearance(floatingCenter, FLOATING_BAR_PLACE.control, hostPillLayout.height, gap, insets.bottom) : design === "material" ? materialPillClearance(materialBottomBar, materialBarPill.height, gap) : null;
  const browsing = surface === "browsing";
  const barSide = design === "redesigned" ? chromeLayout.barSideInset : design === "material" ? materialBottomBar.edge : browseLayout.barSideInset - 4;
  const spot: ToastSpot = {
    safeTop: insets.top,
    keyboardLift: null,
    safeBottom: insets.bottom,
    barClearance: browsing ? shownBarClearance({ full, pill }, pageBar) : full,
    hostBottomY: hostBottom,
    barTopY: browsing ? null : barTop,
    covered,
    gap,
    side: toastSideInset(barSide, Math.max(insets.left, insets.right)),
  };
  return (
    <View
      ref={frame}
      testID="toastLayer"
      collapsable={false}
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
    <Animated.View testID="toastPlace" collapsable={false} style={[styles.host, { left: spot.side, right: spot.side }, place, ride]} pointerEvents="box-none">
      {children}
    </Animated.View>
  );
}

function ResizedPlace({ spot, children }: PlaceProps) {
  const { lift, keyboard } = useBottomLift();
  return (
    <View testID="toastPlace" collapsable={false} style={[styles.host, { left: spot.side, right: spot.side }, toastPlace({ ...spot, keyboardLift: keyboard ? lift : null })]} pointerEvents="box-none">
      {children}
    </View>
  );
}

const ToastPlace = Platform.OS === "ios" ? KeyboardRidingPlace : ResizedPlace;

function useShownToast(reduceMotion: boolean) {
  const toast = useToast();
  const [leaving, setLeaving] = useState<Toast | null>(null);
  const last = useRef<Toast | null>(null);
  const appear = useSharedValue(0);
  const departing = useSharedValue(0);
  const shownId = toast?.id ?? null;
  useLayoutEffect(() => {
    if (toast) {
      last.current = toast;
      setLeaving(null);
      departing.value = 0;
      appear.value = 0;
      appear.value = reduceMotion ? withTiming(1, { duration: tabsMotion.surfaceFade }) : withSpring(1, toastMotion.snappy);
      return;
    }
    const gone = last.current;
    last.current = null;
    if (!gone) return;
    setLeaving(gone);
    departing.value = 1;
    const settle = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(setLeaving)(null);
    };
    appear.value = reduceMotion ? withTiming(0, { duration: tabsMotion.surfaceFade }, settle) : withSpring(0, toastMotion.snappy, settle);
  }, [shownId]);
  return { toast, card: toast ?? leaving, appear, departing };
}

function ToastView({ spot }: { spot: ToastSpot }) {
  const reduceMotion = useReduceMotion();
  const { toast, card, appear, departing } = useShownToast(reduceMotion);
  const drag = useSharedValue(0);
  const pressed = useSharedValue(0);
  const actionable = useSharedValue(false);
  const touch = useSharedValue<ToastTouch>(IDLE_TOAST_TOUCH);
  const actionLabel = toast?.action?.label ?? null;
  const semantics = toastSemantics(actionLabel, Platform.OS);
  useLayoutEffect(() => {
    actionable.value = semantics.pressable;
  }, [semantics.pressable]);
  useEffect(() => {
    drag.value = 0;
    pressed.value = 0;
    touch.value = IDLE_TOAST_TOUCH;
  }, [toast?.id]);
  useEffect(() => {
    if (toast && semantics.announcement === "announceForAccessibility") AccessibilityInfo.announceForAccessibility(toastAnnouncement(toast.spoken, actionLabel));
  }, [toast?.id, toast?.stage]);
  const gesture = useMemo(() => toastTouchGesture({ touch, drag, pressed, actionable, departing, reduceMotion }), [reduceMotion]);
  const shown = useAnimatedStyle(() => {
    const progress = appear.value;
    const travel = departing.value ? (1 - progress) * TOAST_MOTION.exitTravel : (1 - progress) * TOAST_MOTION.enterTravel;
    const scale = departing.value ? 1 : TOAST_MOTION.enterScale + (1 - TOAST_MOTION.enterScale) * progress;
    const held = Math.max(drag.value, drag.value / 4);
    return { opacity: progress * (pressed.value ? press.filledOpacity : 1), transform: [{ translateY: travel + held }, { scale }] };
  });
  if (!card) return null;
  const live = toast !== null;
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (dismissesToast(name)) dismissToast();
    else if (activatesToast(name) && semantics.pressable) tapToast();
  };
  const escape = semantics.escapes ? dismissToast : undefined;
  const spokenLabel = toastAnnouncement(card.spoken, card.action?.label ?? null);
  return (
    <ToastPlace spot={spot} toastId={card.id}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          testID="toast"
          collapsable={false}
          accessible={live}
          importantForAccessibility={live ? "yes" : "no-hide-descendants"}
          accessibilityElementsHidden={!live}
          accessibilityRole={semantics.role}
          accessibilityLabel={spokenLabel}
          accessibilityLiveRegion={semantics.liveRegion}
          accessibilityActions={semantics.actions}
          onAccessibilityAction={onAccessibilityAction}
          onAccessibilityEscape={escape}
          pointerEvents={live ? "auto" : "none"}
          style={[styles.origin, styles.press, shown]}
        >
          <ToastPlate>
            <ToastTileView tile={card.tile} />
            <TextBlock toast={card} reduceMotion={reduceMotion} />
            {card.action ? <ToastButton action={card.action} /> : null}
          </ToastPlate>
        </Animated.View>
      </GestureDetector>
    </ToastPlace>
  );
}

type TouchValues = { touch: SharedValue<ToastTouch>; drag: SharedValue<number>; pressed: SharedValue<number>; actionable: SharedValue<boolean>; departing: SharedValue<number>; reduceMotion: boolean };

export function toastTouchGesture({ touch, drag, pressed, actionable, departing, reduceMotion }: TouchValues) {
  const now = () => {
    "worklet";
    return Date.now();
  };
  return Gesture.Manual()
    .withTestId("toastTouch")
    .onTouchesDown((event, manager) => {
      const point = event.changedTouches[0];
      if (!point || departing.value || event.numberOfTouches > 1) {
        manager.fail();
        return;
      }
      touch.value = toastTouchDown(point.absoluteX, point.absoluteY, now());
      pressed.value = actionable.value ? 1 : 0;
    })
    .onTouchesMove((event, manager) => {
      const point = event.allTouches[0];
      if (!point) return;
      const before = touch.value.phase;
      const next = toastTouchMove(touch.value, point.absoluteX, point.absoluteY, now());
      touch.value = next;
      if (next.phase === "gone") {
        pressed.value = 0;
        manager.fail();
        return;
      }
      if (next.phase !== "dragging") return;
      if (before !== "dragging") {
        pressed.value = 0;
        manager.activate();
        runOnJS(holdToast)(true);
      }
      drag.value = toastTouchDrag(next);
    })
    .onTouchesUp((_event, manager) => {
      const end = toastTouchUp(touch.value, now());
      touch.value = IDLE_TOAST_TOUCH;
      pressed.value = 0;
      if (end === "tap") {
        if (actionable.value) runOnJS(tapToast)();
        manager.end();
        return;
      }
      if (end === "dismiss") {
        runOnJS(dismissToast)();
        manager.end();
        return;
      }
      if (end === "settle") {
        runOnJS(holdToast)(false);
        drag.value = toastDragReturn(reduceMotion) === "snap" ? 0 : withSpring(0, toastMotion.snappy);
      }
      manager.end();
    })
    .onTouchesCancelled((_event, manager) => {
      if (touch.value.phase === "dragging") {
        runOnJS(holdToast)(false);
        drag.value = toastDragReturn(reduceMotion) === "snap" ? 0 : withSpring(0, toastMotion.snappy);
      }
      touch.value = IDLE_TOAST_TOUCH;
      pressed.value = 0;
      manager.fail();
    });
}

function TextBlock({ toast, reduceMotion }: { toast: Toast; reduceMotion: boolean }) {
  const fade = useSharedValue(1);
  const stage = `${toast.key}|${toast.stage}`;
  const seen = useRef(stage);
  useEffect(() => {
    if (seen.current === stage) return;
    seen.current = stage;
    if (reduceMotion) return;
    fade.value = 0;
    fade.value = withTiming(1, { duration: tabsMotion.surfaceFade });
  }, [stage]);
  const faded = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Animated.View testID="toastText" style={[styles.lines, faded]}>
      <PlateText testID="toastTitle" inkRole="toastLabel" style={[font.subheadline, styles.title]} numberOfLines={toast.titleLines} ellipsizeMode={toast.middleTruncates ? "middle" : "tail"}>
        {toast.title}
      </PlateText>
      {toast.detail ? (
        <PlateText testID="toastDetail" inkRole="toastDetail" style={[font.footnote, styles.detail]} numberOfLines={2}>
          {toast.detail}
        </PlateText>
      ) : null}
    </Animated.View>
  );
}

function usePlateDark(): boolean {
  const ink = useSurfaceInk();
  const theme = useTheme();
  return useDesign() === "material" ? backdropIsDark([compositeOver(theme.toastFill, "#808080")]) : ink.dark;
}

function ToastTileView({ tile }: { tile: ToastTile }) {
  const dark = usePlateDark();
  if (tile.kind === "file") {
    return (
      <View testID="toastTile" style={[styles.tile, { backgroundColor: toastTileInk.file[fileKindOf(tile.ext)] }]}>
        <Text allowFontScaling={false} style={[styles.tileText, { color: toastTileInk.fileLabel }]}>
          {fileTileLabel(tile.ext)}
        </Text>
      </View>
    );
  }
  if (tile.kind === "count") {
    return (
      <View testID="toastTile" style={[styles.tile, { backgroundColor: toastTileInk.count }]}>
        <Text allowFontScaling={false} style={[styles.tileText, styles.countText, { color: toastTileInk.countLabel }]}>
          {String(tile.count)}
        </Text>
      </View>
    );
  }
  if (tile.icon === "warning") {
    return (
      <View testID="toastTile" style={[styles.tile, { backgroundColor: toastTileInk.warning }]}>
        <Symbol name={ICONS.warning} size={toastLayout.iconSize} color={toastTileInk.warningGlyph} />
      </View>
    );
  }
  return (
    <View testID="toastTile" style={[styles.tile, { backgroundColor: dark ? toastTileInk.neutral.dark : toastTileInk.neutral.light }]}>
      <PlateSymbol name={ICONS[tile.icon]} size={toastLayout.iconSize} role="toastLabel" />
    </View>
  );
}

function ToastButton({ action }: { action: ToastAction }) {
  const ink = useSurfaceInk();
  const theme = useTheme();
  const dark = usePlateDark();
  const fill = compositeOver(theme.toastFill, dark ? "#000000" : "#FFFFFF");
  return (
    <View style={[styles.button, { backgroundColor: ink.roles.toastLabel }]}>
      <Text testID="toastAction" numberOfLines={1} style={[font.footnote, styles.buttonText, { color: fill }]}>
        {action.label}
      </Text>
    </View>
  );
}

function ToastPlate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const material = useDesign() === "material";
  const face = [styles.plate, { backgroundColor: theme.toastFill, borderColor: theme.panelBorder, shadowColor: theme.toastShadow }];
  if (material) {
    return (
      <View testID="toastPlate" style={[face, styles.materialPlate]}>
        <View style={styles.clip}>{children}</View>
      </View>
    );
  }
  return (
    <View testID="toastPlate" style={[face, styles.cardPlate]}>
      <SurfaceInkProvider dark={theme.dark}>
        <View style={styles.clip}>{children}</View>
      </SurfaceInkProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute", alignItems: "stretch" },
  origin: { transformOrigin: "50% 100%" },
  press: { borderRadius: toastLayout.radius, borderCurve: "continuous" },
  plate: {
    borderRadius: toastLayout.radius,
    borderCurve: "continuous",
    borderWidth: stroke.hairline,
    shadowOpacity: 1,
    shadowRadius: toastLayout.shadowRadius,
    shadowOffset: { width: 0, height: toastLayout.shadowY },
  },
  cardPlate: { elevation: toastGesture.materialElevation },
  materialPlate: { elevation: toastGesture.materialElevation },
  clip: {
    flexDirection: "row",
    alignItems: "center",
    gap: toastLayout.gap,
    minHeight: toastLayout.minHeight,
    paddingLeft: toastLayout.leadingPadding,
    paddingRight: toastLayout.trailingPadding,
    paddingVertical: toastLayout.verticalPadding,
    borderRadius: toastLayout.radius,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  tile: { width: toastLayout.tile, height: toastLayout.tile, borderRadius: toastLayout.tileRadius, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  tileText: { fontSize: toastLayout.tileText, fontWeight: "700", letterSpacing: 0.2 },
  countText: { fontSize: font.footnote.fontSize },
  lines: { flex: 1, minWidth: 0, gap: toastLayout.textGap },
  title: { fontWeight: "600" },
  detail: { fontWeight: "400" },
  button: { height: toastLayout.buttonHeight, paddingHorizontal: toastLayout.buttonPadding, borderRadius: toastLayout.buttonHeight / 2, alignItems: "center", justifyContent: "center" },
  buttonText: { fontWeight: "600" },
});
