import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type AccessibilityActionEvent, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { keyboardIsUp } from "../../lib/trayMotion";
import { backdropIsDark, compositeOver } from "../../lib/readableInk";
import { useBottomLift } from "../search/useKeyboardHeight";
import { useSurface } from "../../state/browse/hooks";
import { useDeckBarTop, usePageBarShown, useToast } from "../../state/toasts/hooks";
import { floatingBarClearance, floatingPillClearance, materialPillClearance, pageBarClearance, shownBarClearance, TOAST_MOTION, toastDragDismisses, toastPlace, toastSideInset, type ToastPlacement } from "../../state/toasts/placement";
import { FLOATING_BAR_PLACE, floatingBarCenter } from "../../lib/deckGeometry";
import { dismissesToast, toastAnnouncement, toastDragReturn, toastSemantics } from "../../state/toasts/semantics";
import { dismissToast, holdToast, tapToast, type Toast, type ToastAction, type ToastIcon, type ToastTile } from "../../state/toasts/store";
import { browseLayout, chromeLayout, font, PlateSymbol, PlateText, space, stroke, SurfaceInkProvider, Symbol, tabsMotion, toastLayout, toastMotion, useDesign, usePressStyle, useSurfaceInk, useTheme, type SymbolName, useReduceMotion } from "../ui";
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
    <Animated.View testID="toastPlace" style={[styles.host, { left: spot.side, right: spot.side }, place, ride]} pointerEvents="box-none">
      {children}
    </Animated.View>
  );
}

function ResizedPlace({ spot, children }: PlaceProps) {
  const { lift, keyboard } = useBottomLift();
  return (
    <View testID="toastPlace" style={[styles.host, { left: spot.side, right: spot.side }, toastPlace({ ...spot, keyboardLift: keyboard ? lift : null })]} pointerEvents="box-none">
      {children}
    </View>
  );
}

const ToastPlace = Platform.OS === "ios" ? KeyboardRidingPlace : ResizedPlace;

function ToastView({ spot }: { spot: ToastSpot }) {
  const toast = useToast();
  const reduceMotion = useReduceMotion();
  const drag = useSharedValue(0);
  const actionLabel = toast?.action?.label ?? null;
  const semantics = toastSemantics(actionLabel, Platform.OS);
  useEffect(() => {
    drag.value = 0;
  }, [toast?.id]);
  useEffect(() => {
    if (toast && semantics.announcement === "announceForAccessibility") AccessibilityInfo.announceForAccessibility(toastAnnouncement(toast.spoken, actionLabel));
  }, [toast?.id, toast?.stage]);
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
  const cardPress = semantics.pressable ? tapToast : undefined;
  const content = (
    <ToastPlate>
      <ToastTileView tile={toast.tile} />
      <TextBlock toast={toast} reduceMotion={reduceMotion} />
      {toast.action ? <ToastButton action={toast.action} /> : null}
    </ToastPlate>
  );
  const spokenLabel = toastAnnouncement(toast.spoken, actionLabel);
  return (
    <ToastPlace spot={spot} toastId={toast.id}>
      <GestureDetector gesture={gesture}>
        <Animated.View key={toast.id} entering={reduceMotion ? REDUCED_IN : toastIn} exiting={reduceMotion ? REDUCED_OUT : toastOut} style={[styles.origin, dragged]}>
          <Pressable
            testID="toast"
            accessible
            accessibilityRole={semantics.role}
            accessibilityLabel={spokenLabel}
            accessibilityLiveRegion={semantics.liveRegion}
            accessibilityActions={semantics.actions}
            onAccessibilityAction={onAccessibilityAction}
            onAccessibilityEscape={escape}
            onPress={cardPress}
            style={cardPress ? pressStyle : styles.press}
          >
            {content}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </ToastPlace>
  );
}

function TextBlock({ toast, reduceMotion }: { toast: Toast; reduceMotion: boolean }) {
  return (
    <Animated.View key={`${toast.key}|${toast.stage}`} testID="toastText" entering={reduceMotion ? undefined : TEXT_IN} style={styles.lines}>
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

const TOAST_SLOP = toastGesture.slop;
const REDUCED_IN = FadeIn.duration(tabsMotion.surfaceFade);
const REDUCED_OUT = FadeOut.duration(tabsMotion.surfaceFade);
const TEXT_IN = FadeIn.duration(tabsMotion.surfaceFade);

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
