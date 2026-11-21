import { createContext, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { countRender } from "../../state/app/interactionPerf";
import { AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SheetScrollContext, SheetScrollView, sheetPullTranslation, type SheetScroll } from "../ui/Sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, FadeIn, FadeOut, runOnJS, runOnUI, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import type { GestureType } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activateRow, cancelSearch, submitSearch, toggleTrayIncognito } from "../../state/browse/store";
import { copyLink, menuOpenedHaptic, trayRowActions } from "../../state/browse/tabMenus";
import { useSearchEditsPage, useSearchFieldVersion, useSearchInitialText, useSearchOpen, useSearchOrigin, useSearchRows, useSearchSession, useSearchText } from "../../state/search/hooks";
import { SEARCH_ANCHOR_ID, SEARCH_FACE_ID, SEARCH_FIELD_ID, SEARCH_REVEAL_ID, SEARCH_ROWS_REVEAL_ID, setStageMorphs, stageExit, stageOpened, stagePresented, stageSettled, useStageBar } from "../../state/search/stageBar";
import { SearchStage, SearchStagePanel, searchStageIsNative, type SearchStageHandle, type SearchStageLift } from "../../platform/searchStage";
import { useScreenLayout } from "../../state/app/screenLayout";
import { isOpenDuo } from "../../lib/bottomBarSpan";
import { initialPresence, presenceSettled, presenceShown, presenceTarget } from "../../lib/sheetPresence";
import { clampedProgress, keyboardIsUp, keyboardProgress, liveLift, TRAY_LIFT, trayDragDismisses, trayDragOffset, trayDragReleasesKeyboard, trayDragTranslation, trayMaxHeight, trayOffset, trayVelocity } from "../../lib/trayMotion";
import { useOnboarding } from "../../state/onboarding/store";
import { useVoice } from "../../state/voice/store";
import { idleScrub, SCRUB, scrubBegin, scrubEnd, scrubMove, type RowFrame, type ScrubState } from "../../lib/trayScrub";
import { rowFade, rowsFadeEdge, rowsOverflow, wholeRowsHeight } from "../../lib/trayRows";
import { haptics } from "../../state/app/haptics";
import { refinedText, type TrayRow } from "../../state/search/omnibox";
import { searchState, setSearchText, typeSearch } from "../../state/search/store";
import { coverTray, followTrayBack, trayBackTravel, useTrayCovers } from "../../state/search/trayBack";
import { useIncognito, useSelectedTab } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage, reportLaunchTray } from "../../state/telemetry/telemetry";
import { browseLayout, capsule, DeckLookBackdrop, Favicon, shape, smoothCorners, FloatingMenu, font, ink, LookFrost, MotionView, moveTo, radius, screenReaderActions, type MotionCurve, type MotionTarget, rolesFor, trayLandingDelayMs, space, stageMotion, barReturnMotion, Symbol, SURFACES_FROST, tabsCurve, tabsInk, tabsLayout, tabsMotion, trayMotion, trayShadow, useTheme, FadeView, fadeIsNative, floatingPanelLayout, useDesign, useReduceTransparency, useReduceMotion, settingsUIAvailable, SystemGlyph } from "../ui";
import { SuggestionRow } from "./SuggestionRow";
import { MaterialSearchTray } from "./MaterialSearchView";
import { TrayInput, type TrayInputHandle } from "./TrayInput";
import { canSearchByVoice, presentVoiceSearch } from "../../state/voice/store";
import { commandBarMotion, commandPanelPlace, useCommandBar } from "../duo/CommandBar";

const LARGE_FONT_SCALE = 1.5;
import { useTrayKeyboard } from "./useTrayKeyboard";
import { useKeyboardTopFromBottom } from "./useKeyboardHeight";
import { searchPanel, searchPanelFieldCenter, searchPanelHeight, searchPanelInk } from "./searchPanelTokens";
import type { Point } from "../../lib/menuPlace";

const SHEET_ABOVE_KEYBOARD = 274;

export const NEW_TAB_FIELD = { gapAbove: 28 } as const;

type TrayList = { drag: GestureType; scroll: SheetScroll };

const TrayListContext = createContext<TrayList | null>(null);

export const SearchPanelContext = createContext(false);

export const searchPanelShown = (phoneLayout: boolean, commandBar: boolean) => phoneLayout && !commandBar;

const PANEL_GLYPHS = { mic: 22, clear: 21 } as const;

const FIELD_SYSTEM_GLYPH = 17;

const INCOGNITO_CAPTION_ROWS = 2;

const ROWS_FALLBACK = 5;

const TRAY_MORPH_CORNERS = { panel: floatingPanelLayout.panelRadius } as const;

const SEARCH_PANEL_CORNERS = { panel: searchPanel.radius } as const;

const FLOATING_PLACE = { cardInset: floatingPanelLayout.inset, cardGap: floatingPanelLayout.aboveKeyboard, fieldInset: floatingPanelLayout.fieldInset, fieldTop: floatingPanelLayout.fieldInset } as const;

const SEARCH_PANEL_PLACE = { cardInset: 0, cardGap: 0, fieldInset: searchPanel.fieldSide, fieldTop: searchPanel.fieldTop } as const;

const trayPanelFill = (incognito: boolean, dark: boolean) => (incognito ? floatingPanelLayout.incognitoFill : dark ? floatingPanelLayout.panelDark : floatingPanelLayout.panelLight);

const frostedPanelFill = (incognito: boolean, dark: boolean, frosted: boolean) => {
  const panelInk = searchPanelInk(incognito, dark);
  return frosted ? panelInk.tint : panelInk.solid;
};

function SearchPanelFace({ incognito, dark, height }: { incognito: boolean; dark: boolean; height?: number }) {
  const reduceTransparency = useReduceTransparency();
  const frosted = Platform.OS === "ios" && !reduceTransparency;
  const fill = frostedPanelFill(incognito, dark, frosted);
  const place = [StyleSheet.absoluteFill, styles.searchPanelFace, height === undefined ? null : { bottom: undefined, height }];
  if (!frosted) return <View testID="searchPanelFace" pointerEvents="none" style={[place, { backgroundColor: fill }]} />;
  return (
    <View testID="searchPanelFace" pointerEvents="none" style={[place, styles.searchPanelClip]}>
      <LookFrost source={SURFACES_FROST} variant="thin" cornerRadius={0} fill={ink.clear} dark={incognito || dark} incognito={incognito} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
    </View>
  );
}

const clearPagePrefill = () => {
  const now = searchState();
  if (now.open && now.editsPage && now.initialText && now.text === now.initialText && now.fieldVersion === 0) setSearchText("");
};

const TrayContentContext = createContext<(height: number) => void>(() => undefined);

const reportRowsHeight = (report: (height: number) => void, height: number) => report(Math.ceil(height));

function useTrayTheme() {
  const base = useTheme();
  const incognito = useIncognito();
  return useMemo(() => (incognito ? { ...base, ...rolesFor(true), surface: tabsInk.incognitoSheet } : base), [base, incognito]);
}

export function SearchTray() {
  const design = useDesign();
  if (design === "material") return <MaterialSearchTray />;
  return searchStageIsNative() ? <StagedTray /> : <SheetTray />;
}

function SheetTray() {
  const open = useSearchOpen();
  const session = useSearchSession();
  const target = open ? session : null;
  const presence = useRef(initialPresence<number>(target));
  const [presentation, setPresentation] = useState(0);
  const [, redraw] = useState(0);
  useEffect(() => {
    const wasClosing = presence.current.target === null && presence.current.mounted !== null;
    const step = presenceTarget(presence.current, target);
    presence.current = step.presence;
    if (step.motion === "in" && (step.fromHidden || wasClosing)) setPresentation((count) => count + 1);
  }, [target]);
  const shown = target ?? presenceShown(presence.current);
  if (shown === null) return null;
  const closed = () => {
    const next = presenceSettled(presence.current, presence.current.generation, true);
    if (next === presence.current) return;
    presence.current = next;
    redraw((count) => count + 1);
  };
  return <TrayLayer key={presentation} session={shown} closing={target === null} onClosed={closed} />;
}

type LayerProps = { session: number; closing: boolean; onClosed: () => void };

function TrayLayer({ session, closing, onClosed }: LayerProps) {
  countRender("TrayLayer");
  const origin = useSearchOrigin();
  const theme = useTrayTheme();
  const incognito = useIncognito();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const keyboard = useTrayKeyboard();
  const arrivesAtRest = useRef(searchState().arrival === "atRest").current;
  const landing = useSharedValue(arrivesAtRest ? 1 : 0);
  const [departed, setDeparted] = useState(false);
  const back = useSharedValue(0);
  const departing = useRef(false);
  const beginDeparture = () => {
    if (!panel || reduceMotion || departing.current) return;
    departing.current = true;
    runOnUI(() => {
      "worklet";
      if (heldLift.value < 0) heldLift.value = liveLift(keyboard.height.value, bottomNow.value, hasLanded.value, false);
    })();
    setDeparted(true);
  };
  const hasLanded = useSharedValue(arrivesAtRest);
  const isClosing = useSharedValue(closing);
  const dim = useSharedValue(0);
  const drag = useSharedValue(0);
  const dragging = useSharedValue(false);
  const released = useSharedValue(false);
  const heldLift = useSharedValue(-1);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safeBottom = insets.bottom;
  const preferred = SHEET_ABOVE_KEYBOARD + browseLayout.searchFieldHeight * (window.fontScale - 1);
  const panel = useDesign() === "redesigned";
  const placement = useCommandBar(Math.max(keyboard.target, safeBottom));
  const command = panel ? placement : null;
  const arcPanel = panel && command === null;
  useLayoutEffect(() => {
    if (arcPanel && !closing) clearPagePrefill();
  }, []);
  const trayHeight = command
    ? command.maxHeight
    : arcPanel
      ? trayMaxHeight(searchPanelHeight(searchPanel.fieldHeight * window.fontScale, window.fontScale), window.height - insets.top - NEW_TAB_FIELD.gapAbove, Math.max(keyboard.target, safeBottom), 0)
      : trayMaxHeight(preferred, window.height - insets.top, Math.max(keyboard.target, safeBottom), space.s + (panel ? floatingPanelLayout.aboveKeyboard : 0));
  const extend = window.height;
  const closedOnPressIn = useRef(false);
  const closeFromTouch = () => {
    if (searchState().open && searchState().session === session) cancelSearch();
  };
  const closeOnPressIn = () => {
    closedOnPressIn.current = true;
    closeFromTouch();
  };
  const closeOnPress = () => {
    if (closedOnPressIn.current) {
      closedOnPressIn.current = false;
      return;
    }
    closeFromTouch();
  };

  useEffect(() => {
    if (closing) return;
    isClosing.value = false;
    const progress = keyboardProgress(keyboard.height.value, keyboard.full.value, 0);
    const landed = arrivesAtRest || (keyboardIsUp(keyboard.height.value) && progress >= TRAY_LIFT.landedProgress);
    hasLanded.value = landed;
    landing.value = landed ? 1 : 0;
    const land = setTimeout(() => {
      if (isClosing.value || hasLanded.value) return;
      hasLanded.value = true;
      landing.value = reduceMotion ? withTiming(1, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }) : moveTo(1, trayMotion.rise);
    }, trayLandingDelayMs);
    return () => clearTimeout(land);
  }, [session, closing]);

  const settleAfterDrag = () => {
    if (heldLift.value < 0 || isClosing.value) return;
    if (mayFocusTray()) focusTray();
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      if (heldLift.value < 0 || isClosing.value) return;
      const to = liveLift(keyboard.height.value, safeBottom, hasLanded.value, false);
      heldLift.value = reduceMotion
        ? withTiming(to, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }, (finished) => {
            if (finished) heldLift.value = -1;
          })
        : withSpring(to, trayMotion.settle, (finished) => {
            if (finished) heldLift.value = -1;
          });
    }, TRAY_LIFT.settleHoldMs);
  };
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const voice = useVoice((state) => state.presented);
  const voiceWasUp = useRef(voice);
  useEffect(() => {
    if (closing) return;
    if (voice) trayInput?.blur();
    else if (voiceWasUp.current && mayFocusTray()) focusTray();
    voiceWasUp.current = voice;
  }, [voice, closing]);

  const heightNow = useSharedValue(trayHeight);
  const bottomNow = useSharedValue(safeBottom);
  const reducedNow = useSharedValue(reduceMotion);
  useEffect(() => {
    heightNow.value = trayHeight;
    bottomNow.value = safeBottom;
    reducedNow.value = reduceMotion;
  }, [trayHeight, safeBottom, reduceMotion]);
  const settleRef = useRef(settleAfterDrag);
  settleRef.current = settleAfterDrag;
  const settleLatest = useCallback(() => settleRef.current(), []);

  const dismissDrag = useMemo(
    () =>
      Gesture.Pan()
        .withTestId("trayDismissDrag")
        .enabled(!closing)
        .activeOffsetY([-10, 10])
        .failOffsetX([-24, 24])
        .onStart(() => {
          cancelAnimation(drag);
          dragging.value = true;
          released.value = false;
        })
        .onUpdate((event) => {
          if (!released.value && trayDragReleasesKeyboard(event.translationY)) {
            released.value = true;
            if (heldLift.value < 0) heldLift.value = liveLift(keyboard.height.value, bottomNow.value, hasLanded.value, isClosing.value);
            runOnJS(letKeyboardGo)();
          }
          drag.value = trayDragOffset(event.translationY);
        })
        .onEnd((event) => {
          dragging.value = false;
          if (trayDragDismisses(event.translationY, event.velocityY, heightNow.value)) {
            runOnJS(cancelSearch)();
            return;
          }
          drag.value = reducedNow.value ? withTiming(0, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }) : withSpring(0, trayMotion.settle);
          runOnJS(settleLatest)();
        }),
    [closing],
  );

  useAnimatedReaction(
    () => (heldLift.value >= 0 && !dragging.value ? Math.abs(liveLift(keyboard.height.value, safeBottom, hasLanded.value, isClosing.value) - heldLift.value) : Infinity),
    (gap) => {
      if (gap < TRAY_LIFT.heldReleaseTolerance) heldLift.value = -1;
    },
  );

  useEffect(() => {
    if (!closing) return;
    isClosing.value = true;
    const departs = panel && !reduceMotion && searchState().ending === "submitted";
    if (departs) beginDeparture();
    putKeyboardAway();
    const followsKeyboard = keyboardIsUp(keyboard.height.value) && heldLift.value < 0;
    if (!departs) landing.value = followsKeyboard
      ? 0
      : reduceMotion
        ? withTiming(0, { duration: trayMotion.reduced, easing: tabsCurve.easeInOut })
        : withSpring(0, trayMotion.dismiss);
    let live = true;
    let stopWaiting = () => {};
    void (async () => {
      if (AppState.currentState === "background") {
        await new Promise<void>((resolve) => {
          const resumes = AppState.addEventListener("change", (next) => {
            if (next !== "active") return;
            resumes.remove();
            resolve();
          });
          stopWaiting = () => resumes.remove();
        });
        if (!live) return;
        putKeyboardAway();
      }
      for (let polls = 0; polls < TRAY_LIFT.closePolls && keyboardIsUp(keyboard.height.value); polls++) await wait(TRAY_LIFT.closePollMs);
      await wait(TRAY_LIFT.removalDelayMs);
      if (live) onClosed();
    })();
    return () => {
      live = false;
      stopWaiting();
    };
  }, [closing]);

  useAnimatedReaction(
    () => keyboardProgress(keyboard.height.value, keyboard.full.value, 0),
    (progress) => {
      if (isClosing.value || hasLanded.value || progress < TRAY_LIFT.landedProgress) return;
      hasLanded.value = true;
      landing.value = 1;
    },
  );

  useAnimatedReaction(
    () => !isClosing.value && (keyboardIsUp(keyboard.height.value) || hasLanded.value),
    (up, was) => {
      if (up === was) return;
      if (up && arrivesAtRest) runOnJS(launchTrayUp)();
      dim.value = withTiming(up ? 1 : 0, { duration: reduceMotion ? trayMotion.reduced : trayMotion.dim, easing: reduceMotion ? tabsCurve.easeOut : trayMotion.dimEasing });
    },
  );

  const currentLift = () => {
    "worklet";
    return heldLift.value >= 0 ? heldLift.value : liveLift(keyboard.height.value, safeBottom, hasLanded.value, isClosing.value);
  };
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value * (1 - clampedProgress(drag.value, trayHeight + currentLift())) }), [trayHeight, safeBottom]);
  const covered = useTrayCovers((state) => state.covers > 0);
  const voicePresented = useVoice((state) => state.presented);
  const trayOnTop = !closing && !covered && !voicePresented;
  useEffect(() => {
    if (!trayOnTop) return;
    const stop = followTrayBack({
      onProgress: (progress) => {
        back.value = progress;
      },
      onCancel: () => {
        back.value = withSpring(0, trayMotion.settle);
      },
      onCommit: () => {
        if (!useTabs.getState().incognito) countUsage("tray_back_swiped");
        cancelSearch();
      },
    });
    return () => {
      stop();
      back.value = withSpring(0, trayMotion.settle);
    };
  }, [trayOnTop]);
  const trayStyle = useAnimatedStyle(() => {
    const lift = currentLift();
    const rise = reduceMotion ? 1 : Math.max(landing.value, keyboardProgress(keyboard.height.value, keyboard.full.value, 0));
    if (command) return commandBarMotion(Math.max(landing.value, keyboardProgress(keyboard.height.value, keyboard.full.value, 0)), dim.value, reduceMotion, drag.value, back.value * trayBackTravel);
    return {
      opacity: reduceMotion ? dim.value : 1,
      transform: [{ translateY: trayOffset(lift, drag.value, rise, trayHeight, arcPanel ? searchPanel.radius : panel ? floatingPanelLayout.panelRadius : radius.sheet) + back.value * trayBackTravel }],
    };
  }, [trayHeight, safeBottom, reduceMotion, panel, command !== null]);

  return (
    <DepartContext.Provider value={beginDeparture}>
    <View testID="trayRoot" style={StyleSheet.absoluteFill} pointerEvents={closing ? "none" : "box-none"} collapsable={false} importantForAccessibility={closing ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={closing}>
      <Animated.View testID="trayDim" style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable
          accessibilityLabel="Close Search"
          accessibilityRole="button"
          {...screenReaderActions([{ name: "activate", run: closeFromTouch }])}
          onPressIn={closeOnPressIn}
          onPress={closeOnPress}
          style={[StyleSheet.absoluteFill, { backgroundColor: origin === "page" ? theme.trayDim : ink.clear }]}
        />
      </Animated.View>
      {panel ? (
        <MotionView style={StyleSheet.absoluteFill} pointerEvents="box-none" to={departed ? PANEL_DEPARTED : PANEL_HOME} motion={PANEL_DEPART}>
        <Animated.View
          testID="trayPanel"
          style={[
            command ? commandPanelPlace(command) : arcPanel ? [styles.searchPanelSurface, styles.searchPanelSheet, { left: insets.left, right: insets.right, bottom: -extend, height: trayHeight + extend }] : [styles.panel, { left: insets.left + floatingPanelLayout.inset, right: insets.right + floatingPanelLayout.inset, height: trayHeight }],
            { boxShadow: incognito ? floatingPanelLayout.incognitoShadow : floatingPanelLayout.shadow },
            trayStyle,
          ]}
        >
          {arcPanel ? (
            <SearchPanelFace incognito={incognito} dark={theme.dark} />
          ) : (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.panelFace, { backgroundColor: trayPanelFill(incognito, theme.dark), borderColor: theme.dark || incognito ? theme.panelBorder : ink.clear }]} />
          )}
          <View style={[arcPanel ? styles.searchPanelClip : styles.panelClip, { height: trayHeight }]}>
            <SearchPanelContext.Provider value={arcPanel}>
              <GestureDetector gesture={dismissDrag}>
                <View collapsable={false}>
                  <TrayField key={session} closing={closing} />
                </View>
              </GestureDetector>
              <TrayRows dismissDrag={dismissDrag} />
            </SearchPanelContext.Provider>
          </View>
        </Animated.View>
        </MotionView>
      ) : (
      <Animated.View
        style={[
          styles.sheet,
          {
            bottom: -extend,
            height: trayHeight + extend,
            backgroundColor: incognito ? theme.surface : ink.clear,
            shadowColor: theme.trayShadow,
            shadowOpacity: trayShadow.opacity,
            shadowRadius: trayShadow.radius,
            shadowOffset: { width: 0, height: trayShadow.offsetY },
          },
          trayStyle,
        ]}
      >
        {incognito ? null : <LookFrost source={SURFACES_FROST} variant="sheet" cornerRadius={radius.sheet} fill={theme.surface} style={StyleSheet.absoluteFill} />}
        <View style={{ height: trayHeight }}>
          <GestureDetector gesture={dismissDrag}>
            <View collapsable={false}>
              <TrayField key={session} closing={closing} />
            </View>
          </GestureDetector>
          <TrayRows dismissDrag={dismissDrag} />
        </View>
      </Animated.View>
      )}
    </View>
    </DepartContext.Provider>
  );
}

let knownLift = 0;
let knownFieldHeight = 0;
let knownRowsHeight = 0;

type StagedField = { holdsScroll: boolean; presented: boolean; onFieldHeight: (height: number) => void };

const StagedFieldContext = createContext<StagedField | null>(null);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);


function StagedTray() {
  countRender("TrayLayer");
  const open = useSearchOpen();
  const session = useSearchSession();
  const origin = useSearchOrigin();
  const theme = useTrayTheme();
  const incognito = useIncognito();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();
  const phoneLayout = useScreenLayout((s) => s.layout.name === "phone");
  const hinged = useScreenLayout((s) => s.hinge !== "none");
  const landsDirectly = useScreenLayout((s) => isOpenDuo(window.width, s.hinge));
  const pills = useStageBar((state) => state.pills);
  const stage = useRef<SearchStageHandle>(null);
  const [mounted, setMounted] = useState<number | null>(open ? session : null);
  const [presentation, setPresentation] = useState(0);
  const [closing, setClosing] = useState(false);
  const [stageShown, setStageShown] = useState(open);
  const [holdsScroll, setHoldsScroll] = useState(open);
  const [presented, setPresented] = useState(false);
  const [lift, setLift] = useState<SearchStageLift>({ lift: knownLift, up: false });
  const [fieldHeight, setFieldHeight] = useState(knownFieldHeight || searchPanel.fieldHeight * window.fontScale);
  const [rowsHeight, setRowsHeight] = useState(knownRowsHeight || ROWS_FALLBACK * browseLayout.suggestionPitch * window.fontScale);
  const live = useRef<{ mounted: number | null; closing: boolean; revealed: boolean; velocity: number; morphs: boolean; presentation: number }>({ mounted: null, closing: false, revealed: false, velocity: 0, morphs: false, presentation: 0 });
  const heldRelease = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useSharedValue(0);
  const grabbed = useSharedValue(0);
  const released = useSharedValue(false);
  const dim = useSharedValue(0);
  const safeBottom = insets.bottom;
  const resting = Math.max(lift.lift, safeBottom);
  const command = useCommandBar(resting);
  const editsPage = useSearchEditsPage();
  const arcPanel = mounted !== null && searchPanelShown(phoneLayout, command !== null);
  const fieldBlock = floatingPanelLayout.fieldInset + fieldHeight + space.xs;
  const preferred = arcPanel ? searchPanelHeight(fieldHeight, window.fontScale) : Math.min(SHEET_ABOVE_KEYBOARD + browseLayout.searchFieldHeight * (window.fontScale - 1), fieldBlock + rowsHeight);
  const trayHeight = command ? command.maxHeight : arcPanel ? trayMaxHeight(preferred, window.height - insets.top - NEW_TAB_FIELD.gapAbove, resting, 0) : trayMaxHeight(preferred, window.height - insets.top, resting, space.s + floatingPanelLayout.aboveKeyboard);
  const underKeyboard = arcPanel ? resting : 0;
  const place = arcPanel ? (hinged ? { ...SEARCH_PANEL_PLACE, cardInset: floatingPanelLayout.inset } : SEARCH_PANEL_PLACE) : FLOATING_PLACE;
  const newTabPanelNow = useRef(!editsPage && arcPanel);
  newTabPanelNow.current = !editsPage && arcPanel;
  const morphs = phoneLayout && !reduceMotion && command === null && pills > 0;
  live.current.morphs = morphs;
  const heightNow = useSharedValue(trayHeight);
  const travel = useSharedValue(trayHeight + lift.lift);
  const reducedNow = useSharedValue(reduceMotion);
  useEffect(() => {
    heightNow.value = trayHeight;
    travel.value = trayHeight + lift.lift;
    reducedNow.value = reduceMotion;
  }, [trayHeight, lift.lift, reduceMotion]);
  useEffect(() => {
    if (mounted !== null) setStageMorphs(morphs);
  }, [morphs, mounted !== null]);

  const clearHeldRelease = () => {
    if (heldRelease.current) clearTimeout(heldRelease.current);
    heldRelease.current = null;
  };
  useEffect(() => clearHeldRelease, []);

  useEffect(() => {
    const now = live.current;
    if (open) {
      if (now.mounted === null || now.closing) setPresentation((count) => count + 1);
      now.mounted = session;
      now.closing = false;
      now.revealed = false;
      now.velocity = 0;
      if (searchPanelShown(phoneLayout, command !== null)) clearPagePrefill();
      setMounted(session);
      setClosing(false);
      setHoldsScroll(true);
      drag.value = 0;
      stageOpened();
      setStageMorphs(now.morphs);
      setStageShown(true);
      return;
    }
    if (now.mounted === null || now.closing) return;
    now.closing = true;
    clearHeldRelease();
    setClosing(true);
    setHoldsScroll(true);
    putKeyboardAway();
    const velocity = now.velocity;
    now.velocity = 0;
    stage.current?.close(stageExit(searchState().ending, now.morphs), velocity);
  }, [open, session]);

  useEffect(() => {
    live.current.presentation = presentation;
    if (presentation === 0) return;
    if (newTabPanelNow.current && !useTabs.getState().incognito) countUsage("new_tab_search_opened");
    setPresented(false);
    const launch = searchState().arrival === "atRest";
    void stage.current?.present().then(() => {
      if (live.current.presentation !== presentation || live.current.closing) return;
      if (launch) launchTrayUp();
      setPresented(true);
      stagePresented();
    });
  }, [presentation]);

  const [handOver, setHandOver] = useState(0);
  useEffect(() => {
    if (handOver === 0 || live.current.mounted !== null) return;
    drag.value = 0;
    stage.current?.finish();
    startTransition(() => {
      if (live.current.mounted !== null) return;
      setMounted(null);
      setClosing(false);
      setStageShown(false);
    });
  }, [handOver]);

  const settled = ({ landed }: { landed: boolean }) => {
    const now = live.current;
    if (!now.closing) return;
    now.closing = false;
    now.mounted = null;
    clearHeldRelease();
    stageSettled(landed);
    setHoldsScroll(false);
    setHandOver((count) => count + 1);
  };

  const revealed = ({ late }: { late: boolean }) => {
    live.current.revealed = true;
    if (!live.current.closing) setHoldsScroll(false);
    if (late && !useTabs.getState().incognito) countUsage("search_reveals_late");
  };

  const lifted = (next: SearchStageLift) => {
    if (next.up && next.lift > 0) knownLift = next.lift;
    setLift((was) => (was.lift === next.lift && was.up === next.up ? was : next));
  };
  const dimUp = arcPanel ? !closing : lift.up;
  useEffect(() => {
    dim.value = withTiming(dimUp ? 1 : 0, { duration: reduceMotion ? barReturnMotion.fadeMs : stageMotion.dimMs, easing: tabsCurve.easeOut });
  }, [dimUp]);

  const measuredRows = useCallback((height: number) => {
    knownRowsHeight = height;
    setRowsHeight((was) => (Math.abs(was - height) < 1 ? was : height));
  }, []);

  const measuredField = useCallback((height: number) => {
    if (height <= 0) return;
    knownFieldHeight = height;
    setFieldHeight((was) => (Math.abs(was - height) < 0.5 ? was : height));
  }, []);

  const voice = useVoice((state) => state.presented);
  const voiceWasUp = useRef(voice);
  useEffect(() => {
    if (closing) return;
    if (voice) trayInput?.blur();
    else if (voiceWasUp.current && mayFocusTray()) focusTray();
    voiceWasUp.current = voice;
  }, [voice, closing]);

  const closedOnPressIn = useRef(false);
  const closeFromTouch = () => {
    if (searchState().open && searchState().session === live.current.mounted) cancelSearch();
  };
  const closeOnPressIn = () => {
    closedOnPressIn.current = true;
    closeFromTouch();
  };
  const closeOnPress = () => {
    if (closedOnPressIn.current) {
      closedOnPressIn.current = false;
      return;
    }
    closeFromTouch();
  };

  const letKeyboardGoHeld = () => {
    clearHeldRelease();
    if (!Keyboard.isVisible()) return;
    stage.current?.holdLift();
    putKeyboardAway();
  };
  const settleHeld = () => {
    if (live.current.closing) return;
    if (mayFocusTray()) focusTray();
    clearHeldRelease();
    heldRelease.current = setTimeout(() => {
      heldRelease.current = null;
      if (!live.current.closing) stage.current?.releaseLift();
    }, stageMotion.heldLiftGraceMs);
  };
  const dismissByDrag = (velocity: number) => {
    live.current.velocity = velocity;
    closeFromTouch();
  };
  const handlers = useRef({ letKeyboardGoHeld, settleHeld, dismissByDrag, clearHeldRelease });
  handlers.current = { letKeyboardGoHeld, settleHeld, dismissByDrag, clearHeldRelease };
  const onGrab = useCallback(() => handlers.current.clearHeldRelease(), []);
  const onRelease = useCallback(() => handlers.current.letKeyboardGoHeld(), []);
  const onSettle = useCallback(() => handlers.current.settleHeld(), []);
  const onDismiss = useCallback((velocity: number) => handlers.current.dismissByDrag(velocity), []);

  const listAtTop = useSharedValue(true);
  const listScrolls = useSharedValue(false);
  const listNative = useMemo(() => Gesture.Native(), []);
  const trayDrag = (testId: string, list: boolean) =>
    Gesture.Pan()
      .withTestId(testId)
      .enabled(!closing)
      .activeOffsetY([-10, 10])
      .failOffsetX([-24, 24])
      .simultaneousWithExternalGesture(list ? listNative : Gesture.Manual().enabled(false))
      .onStart(() => {
        cancelAnimation(drag);
        grabbed.value = trayDragTranslation(drag.value);
        released.value = false;
        runOnJS(onGrab)();
      })
      .onUpdate((event) => {
        const pulled = list ? sheetPullTranslation(event.translationY, listScrolls.value, listAtTop.value) : event.translationY;
        const translation = grabbed.value + pulled;
        if (!released.value && trayDragReleasesKeyboard(translation)) {
          released.value = true;
          runOnJS(onRelease)();
        }
        drag.value = trayDragOffset(translation);
      })
      .onEnd((event) => {
        const pulled = list ? sheetPullTranslation(event.translationY, listScrolls.value, listAtTop.value) : event.translationY;
        const speed = pulled === 0 ? 0 : event.velocityY;
        const translation = grabbed.value + pulled;
        grabbed.value = 0;
        const velocity = trayVelocity(translation, speed);
        if (trayDragDismisses(translation, speed, heightNow.value)) {
          runOnJS(onDismiss)(velocity);
          return;
        }
        drag.value = reducedNow.value ? withTiming(0, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }) : withSpring(0, { ...stageMotion.settle, velocity });
        if (released.value) runOnJS(onSettle)();
      });
  const dismissDrag = useMemo(() => trayDrag("trayDismissDrag", false), [closing]);
  const listDrag = useMemo(() => trayDrag("trayListDrag", true), [closing]);
  const trayList = useMemo<TrayList>(() => ({ drag: listDrag, scroll: { native: listNative, atTop: listAtTop, scrolls: listScrolls } }), [listDrag, listNative]);

  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value * (1 - clampedProgress(drag.value, travel.value)) }));
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }));
  const panelFill = trayPanelFill(incognito, theme.dark);
  const morphFrosted = arcPanel && !reduceTransparency;
  const morphPanel = arcPanel ? frostedPanelFill(incognito, theme.dark, morphFrosted) : panelFill;
  const morphLook = useMemo(() => ({ usesGlass: false, panelTint: ink.clear, panelDark: incognito, classicPanel: morphPanel, frosted: morphFrosted }), [morphPanel, incognito, morphFrosted]);
  const overPage = origin === "page";
  const dimTakesTouches = (arcPanel || lift.up) && !closing;
  const field = useMemo<StagedField>(() => ({ holdsScroll, presented, onFieldHeight: measuredField }), [holdsScroll, presented, measuredField]);

  return (
    <SearchStage
      ref={stage}
      testID="trayStage"
      style={StyleSheet.absoluteFill}
      shown={stageShown}
      anchorNativeId={morphs ? SEARCH_ANCHOR_ID : null}
      faceNativeId={morphs ? SEARCH_FACE_ID : null}
      focusNativeId={SEARCH_FIELD_ID}
      revealNativeId={SEARCH_REVEAL_ID}
      rowsRevealNativeId={SEARCH_ROWS_REVEAL_ID}
      fieldCenter={arcPanel ? searchPanelFieldCenter(fieldHeight) : floatingPanelLayout.fieldInset + fieldHeight / 2}
      cardInset={place.cardInset}
      cardGap={place.cardGap}
      fieldInset={place.fieldInset}
      fieldTop={place.fieldTop}
      commandTop={command ? command.top : null}
      landsDirectly={landsDirectly}
      morphLook={morphLook}
      morphCorners={arcPanel ? SEARCH_PANEL_CORNERS : TRAY_MORPH_CORNERS}
      onLift={lifted}
      onReveal={revealed}
      onSettled={settled}
    >
      <AnimatedPressable
        testID="trayDim"
        accessibilityLabel="Close Search"
        accessibilityRole="button"
        {...screenReaderActions([{ name: "activate", run: closeFromTouch }])}
        collapsable={false}
        pointerEvents={dimTakesTouches ? "auto" : "none"}
        importantForAccessibility={dimTakesTouches ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!dimTakesTouches}
        onPressIn={closeOnPressIn}
        onPress={closeOnPress}
        style={[StyleSheet.absoluteFill, { backgroundColor: overPage ? theme.trayDim : ink.clear }, dimStyle]}
      >
        {overPage && !reduceTransparency ? <LookFrost source={SURFACES_FROST} variant="thin" cornerRadius={0} fill={theme.trayDim} dark={incognito || theme.dark} style={StyleSheet.absoluteFill} /> : null}
        {arcPanel && !overPage && !incognito ? <DeckLookBackdrop /> : null}
      </AnimatedPressable>
      <SearchStagePanel testID="trayPanel" pointerEvents="box-none" style={command ? [styles.stagePanel, { top: command.top }] : [styles.stagePanel, { bottom: -underKeyboard }]}>
        <Animated.View testID="trayDrag" collapsable={false} style={dragStyle}>
          {mounted !== null ? (
            <View
              key={presentation}
              style={command ? { marginLeft: command.left, width: command.width } : hinged ? [arcPanel ? null : styles.stageCard, { paddingLeft: insets.left + floatingPanelLayout.inset, paddingRight: insets.right + floatingPanelLayout.inset }] : arcPanel ? { paddingLeft: insets.left, paddingRight: insets.right } : styles.stageCard}
              importantForAccessibility={closing ? "no-hide-descendants" : "auto"}
              accessibilityElementsHidden={closing}
            >
              <View testID="traySurface" style={[arcPanel ? styles.searchPanelSurface : styles.stageSurface, { height: trayHeight + underKeyboard, boxShadow: incognito ? floatingPanelLayout.incognitoShadow : floatingPanelLayout.shadow }]}>
                {arcPanel ? (
                  <SearchPanelFace incognito={incognito} dark={theme.dark} />
                ) : (
                  <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.panelFace, { backgroundColor: panelFill, borderColor: theme.dark || incognito ? theme.panelBorder : ink.clear }]} />
                )}
                <View style={[arcPanel ? styles.searchPanelClip : styles.panelClip, { height: trayHeight + underKeyboard }]}>
                  <TrayContentContext.Provider value={measuredRows}>
                  <SearchPanelContext.Provider value={arcPanel}>
                    <TrayListContext.Provider value={arcPanel ? trayList : null}>
                    <StagedFieldContext.Provider value={field}>
                      <GestureDetector gesture={dismissDrag}>
                        <View collapsable={false}>
                          <TrayField key={mounted} closing={closing} />
                        </View>
                      </GestureDetector>
                    </StagedFieldContext.Provider>
                    <View testID="trayRowsReveal" nativeID={SEARCH_ROWS_REVEAL_ID} collapsable={false} style={[styles.rows, { paddingBottom: underKeyboard }]}>
                      <TrayRows dismissDrag={dismissDrag} />
                    </View>
                    </TrayListContext.Provider>
                  </SearchPanelContext.Provider>
                  </TrayContentContext.Provider>
                </View>
              </View>
            </View>
          ) : null}
        </Animated.View>
      </SearchStagePanel>
    </SearchStage>
  );
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const DepartContext = createContext<() => void>(() => undefined);

const PANEL_HOME: MotionTarget = { opacity: 1, translateY: 0 };
const PANEL_DEPARTED: MotionTarget = { opacity: 0, translateY: -floatingPanelLayout.departLift };
const PANEL_DEPART: MotionCurve = { type: "timing", durationMs: floatingPanelLayout.departMs, curve: [0.2, 0, 0, 1] };

function useLeavingActions() {
  const depart = useContext(DepartContext);
  return useMemo(() => {
    const departIfLeft = () => {
      const now = searchState();
      if (!now.open && now.ending === "submitted") depart();
    };
    return {
      submit: (text: string) => {
        const opened = submitSearch(text);
        if (opened) departIfLeft();
        return opened;
      },
      activate: (row: TrayRow) => {
        activateRow(row);
        departIfLeft();
      },
    };
  }, [depart]);
}

const launchTrayUp = () => void reportLaunchTray(Date.now());

const putKeyboardAway = () => {
  trayInput?.blur();
  Keyboard.dismiss();
};

const letKeyboardGo = () => putKeyboardAway();

const resultsIn = FadeIn.duration(trayMotion.resultsIn);
const resultsOut = FadeOut.duration(trayMotion.resultsIn);

const modeToggleIn = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },
    animations: { opacity: withSpring(1, trayMotion.modeToggle), transform: [{ scale: withSpring(1, trayMotion.modeToggle) }] },
  };
};

const modeToggleOut = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withSpring(0, trayMotion.modeToggle), transform: [{ scale: withSpring(0.9, trayMotion.modeToggle) }] },
  };
};

let trayInput: TrayInputHandle | null = null;

const focusTray = () => trayInput?.focus();

const mayFocusTray = () => !useOnboarding.getState().showing && !useVoice.getState().presented;

function TrayField({ closing }: { closing: boolean }) {
  const version = useSearchFieldVersion();
  return <FieldInput key={version} first={version === 0} closing={closing} />;
}

function FieldInput({ first, closing }: { first: boolean; closing: boolean }) {
  const leaving = useLeavingActions();
  const theme = useTrayTheme();
  const panelField = useDesign() === "redesigned";
  const incognitoField = useIncognito();
  const initialText = useSearchInitialText();
  const [start] = useState(() => searchState().text);
  const [hasText, setHasText] = useState(start.length > 0);
  const input = useRef<TrayInputHandle | null>(null);
  const submitted = useRef(false);
  const staged = useContext(StagedFieldContext);
  const arc = useContext(SearchPanelContext);

  const [fieldGone, dropField] = useState(false);
  useEffect(() => {
    if (closing) {
      input.current?.blur();
      if (!staged) dropField(true);
      return;
    }
    if (staged && !staged.presented) return;
    if (staged) {
      input.current?.focus();
      return;
    }
    const focus = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, [closing, staged?.presented]);
  const lastText = useRef(start);
  const arcInk = searchPanelInk(incognitoField, theme.dark);
  const areaStyle = arc ? styles.searchPanelFieldArea : panelField ? styles.panelFieldArea : styles.fieldArea;
  const capsuleStyle = arc
    ? [styles.searchPanelField, { backgroundColor: arcInk.field, borderColor: arcInk.fieldEdge }]
    : [styles.field, panelField ? [styles.panelField, theme.dark || incognitoField ? styles.panelFieldDark : styles.panelFieldLight] : { backgroundColor: theme.fieldFill, borderColor: theme.fieldStroke }];
  const inputStyle = arc ? styles.searchPanelInput : [styles.input, panelField ? styles.panelInput : null];

  return (
    <View testID={arc ? "searchPanelFieldRow" : undefined} style={areaStyle}>
      <View testID="trayFieldCapsule" onLayout={staged ? (event) => staged.onFieldHeight(event.nativeEvent.layout.height) : undefined} style={capsuleStyle}>
        <View testID="trayFieldReveal" nativeID={staged ? SEARCH_REVEAL_ID : undefined} collapsable={false} style={[styles.fieldContents, panelField ? styles.panelField : null]}>
        {fieldGone ? (
          <Text testID="trayFieldLeaving" numberOfLines={1} style={[font.title3, styles.input, styles.leavingText, arc ? styles.searchPanelWeight : null, { color: lastText.current ? theme.foregroundPrimary : theme.foregroundTertiary }]}>
            {lastText.current || "Search…"}
          </Text>
        ) : (
        <TrayInput
          ref={(field) => {
            input.current = field;
            trayInput = field;
          }}
          style={inputStyle}
          weight={arc ? "medium" : "regular"}
          start={start}
          selectsStart={first && Boolean(initialText)}
          color={theme.foregroundPrimary}
          placeholderColor={theme.foregroundTertiary}
          accent={theme.spaceAccentInk}
          keyboardAppearance={incognitoField ? "dark" : "default"}
          holdsScroll={staged?.holdsScroll}
          nativeID={staged ? SEARCH_FIELD_ID : undefined}
          onTyped={(text) => {
            lastText.current = text;
            if (text.length > 0 !== hasText) setHasText(text.length > 0);
            typeSearch(text);
          }}
          onSubmit={(text) => {
            if (submitted.current) return;
            if (leaving.submit(text)) submitted.current = true;
          }}
        />
        )}
        {hasText ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear Text" style={styles.accessory} onPress={() => input.current?.clearsInPlace() || setSearchText("")}>
            <SystemGlyph testID="trayClearGlyph" systemName="xmark.circle.fill" pointSize={FIELD_SYSTEM_GLYPH} name="xmarkCircleFill" size={panelField ? PANEL_GLYPHS.clear : 18} color={theme.foregroundTertiary} />
          </Pressable>
        ) : (
          <VoiceButton />
        )}
        {arc ? <PanelIncognitoToggle /> : <IncognitoToggle />}
        </View>
      </View>
    </View>
  );
}

function VoiceButton() {
  const theme = useTrayTheme();
  const incognito = useIncognito();
  const { fontScale } = useWindowDimensions();
  const panelField = useDesign() === "redesigned";
  if (incognito || fontScale > LARGE_FONT_SCALE || !canSearchByVoice()) return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Voice Search" style={styles.accessory} onPress={presentVoiceSearch}>
      <SystemGlyph testID="trayMicGlyph" systemName="mic" pointSize={FIELD_SYSTEM_GLYPH} weight="medium" name="mic" size={panelField ? PANEL_GLYPHS.mic : 19} color={theme.foregroundTertiary} />
    </Pressable>
  );
}

const INCOGNITO_GLYPH = 26;
const INCOGNITO_PLATE = 34;

function IncognitoToggle() {
  const theme = useTrayTheme();
  const on = useIncognito();
  const panelField = useDesign() === "redesigned";
  return (
    <Pressable
      testID="trayIncognito"
      accessibilityRole="button"
      accessibilityLabel={on ? "Deactivate Incognito" : "Activate Incognito"}
      onPress={toggleTrayIncognito}
      style={[styles.incognito, panelField ? styles.panelIncognito : null]}
    >
      <View testID="trayIncognitoGlyph" style={styles.incognitoGlyph}>
        {on && Platform.OS !== "android" ? <Animated.View testID="trayIncognitoPlate" entering={modeToggleIn} exiting={modeToggleOut} style={styles.incognitoPlate} /> : null}
        <IncognitoEyes incognito={on} size={INCOGNITO_GLYPH} color={on ? tabsInk.onDark : theme.foregroundTertiary} />
      </View>
    </Pressable>
  );
}

function PanelIncognitoToggle() {
  const theme = useTrayTheme();
  const on = useIncognito();
  const { fontScale } = useWindowDimensions();
  return (
    <Pressable testID="trayIncognito" accessibilityRole="button" accessibilityLabel={on ? "Deactivate Incognito" : "Activate Incognito"} hitSlop={space.xs} onPress={toggleTrayIncognito} style={styles.panelIncognitoToggle}>
      {on && fontScale <= LARGE_FONT_SCALE ? (
        <Animated.Text testID="trayIncognitoLabel" entering={modeToggleIn} exiting={modeToggleOut} numberOfLines={1} style={[styles.panelIncognitoLabel, { color: searchPanel.incognito.label }]}>
          Incognito
        </Animated.Text>
      ) : null}
      <View testID="trayIncognitoGlyph">
        <IncognitoEyes incognito={on} size={searchPanel.eyes} color={on ? searchPanel.incognito.label : theme.foregroundTertiary} />
      </View>
    </Pressable>
  );
}

function TrayRows({ dismissDrag }: { dismissDrag: GestureType }) {
  const leaving = useLeavingActions();
  const theme = useTrayTheme();
  const rows = useSearchRows();
  const typed = useSearchText();
  const incognito = useIncognito();
  const [room, setRoom] = useState(0);
  const [bottoms, setBottoms] = useState<number[]>([]);
  const refine = useCallback((row: TrayRow) => setSearchText(refinedText(row)), []);
  const [menu, setMenu] = useState<{ row: TrayRow; at: Point } | null>(null);
  const menuOpen = menu !== null;
  useEffect(() => (menuOpen ? coverTray() : undefined), [menuOpen]);
  const window = useWindowDimensions();
  const keyboardTop = useKeyboardTopFromBottom();
  const showMenu = useCallback((row: TrayRow, at: Point) => {
    if (!trayRowActions(row).length) return;
    menuOpenedHaptic();
    setMenu({ row, at });
  }, []);
  const arc = useContext(SearchPanelContext);
  const list = useContext(TrayListContext);
  const reportRows = useContext(TrayContentContext);
  const editsPage = useSearchEditsPage();
  const caption = incognito && !typed.trim();
  const openedPage = useOpenedPage();
  const currentPage = arc && editsPage && openedPage && !typed.trim() ? <CurrentPageRow page={openedPage} /> : null;
  const empty = !caption && !rows.length;
  useEffect(() => {
    if (caption) reportRows(INCOGNITO_CAPTION_ROWS * browseLayout.suggestionPitch * window.fontScale);
    else if (empty) reportRows(space.s);
  }, [caption, empty, window.fontScale]);
  const shown = wholeRowsHeight(
    rows.map((_row, index) => bottoms[index] ?? 0),
    room,
  );
  if (caption && arc) {
    return (
      <GestureDetector gesture={dismissDrag}>
        <Animated.View key="caption" testID="searchPanelCaption" entering={resultsIn} exiting={resultsOut} style={styles.rows}>
          {currentPage ? <View style={styles.searchPanelRowsContent}>{currentPage}</View> : null}
          <View style={[styles.rows, styles.incognitoNote]}>
            <Text style={[styles.searchPanelCaption, styles.centered, { color: searchPanel.incognito.caption }]}>You’re browsing Incognito</Text>
          </View>
        </Animated.View>
      </GestureDetector>
    );
  }
  if (caption) {
    return (
      <GestureDetector gesture={dismissDrag}>
        <Animated.View key="caption" entering={resultsIn} exiting={resultsOut} style={[styles.rows, styles.incognitoNote]}>
          <Text style={[font.title3, styles.semibold, styles.centered, { color: tabsInk.onDarkSoft }]}>You’re browsing Incognito</Text>
        </Animated.View>
      </GestureDetector>
    );
  }
  if (!rows.length && !currentPage) {
    return (
      <GestureDetector gesture={dismissDrag}>
        <Animated.View key="empty" entering={resultsIn} exiting={resultsOut} style={styles.rows} collapsable={false} />
      </GestureDetector>
    );
  }
  const menuView = menu ? (
    <FloatingMenu
      items={trayRowActions(menu.row).map((action) => ({ label: action.label, icon: action.icon, onPress: action.run }))}
      at={menu.at}
      floor={keyboardTop ? window.height - keyboardTop : undefined}
      dimmed
      frost={null}
      place={{ width: Math.min(tabsLayout.menuWidth, window.width - space.xl * 2) }}
      onDismiss={() => setMenu(null)}
    />
  ) : null;
  const measure = (index: number, layout: { y: number; height: number }) => {
    const bottom = layout.y + layout.height;
    setBottoms((known) => (known[index] === bottom ? known : Object.assign([...known], { [index]: bottom })));
  };
  const rowViews = rows.map((row, index) => (
    <View key={index} onLayout={(event) => measure(index, event.nativeEvent.layout)}>
      <SuggestionRow row={row} typed={typed} roles={theme} menu={trayRowActions(row)} onActivate={leaving.activate} onRefine={refine} onMenu={showMenu} />
    </View>
  ));
  if (window.fontScale <= LARGE_FONT_SCALE && !arc) {
    return (
      <Animated.View key="rows" testID="trayRows" entering={resultsIn} exiting={resultsOut} style={styles.rows} onLayout={(event) => setRoom(event.nativeEvent.layout.height)}>
        <ScrubbedRows rows={rows} typed={typed} budget={room} onRefine={refine} onMenu={showMenu} onContentHeight={(height) => reportRowsHeight(reportRows, height)} />
        {menuView}
      </Animated.View>
    );
  }
  return (
    <Animated.View key="rows" testID={arc ? "searchPanelRows" : undefined} entering={resultsIn} exiting={resultsOut} style={styles.rows} onLayout={(event) => setRoom(event.nativeEvent.layout.height)}>
      {list ? (
        <GestureDetector gesture={list.drag}>
          <View style={styles.rows} collapsable={false}>
            <SheetScrollContext.Provider value={list.scroll}>
              <SheetScrollView testID="searchPanelRowsScroll" style={styles.rows} contentContainerStyle={arc ? styles.searchPanelRowsContent : styles.rowsContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="none" bounces={false} onContentSizeChange={(_width, height) => reportRowsHeight(reportRows, height)}>
                {currentPage}
                {rowViews}
              </SheetScrollView>
            </SheetScrollContext.Provider>
          </View>
        </GestureDetector>
      ) : (
        <ScrollView
          testID={arc ? "searchPanelRowsScroll" : undefined}
          style={arc || shown === null ? styles.rows : { height: shown, flexGrow: 0 }}
          contentContainerStyle={arc ? styles.searchPanelRowsContent : styles.rowsContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          onContentSizeChange={(_width, height) => reportRowsHeight(reportRows, height)}
        >
          {currentPage}
          {rowViews}
        </ScrollView>
      )}
      {menuView}
    </Animated.View>
  );
}

type OpenedPage = { key: string; url: string; title: string; faviconUrl: string | null; initialText: string };

function useOpenedPage(): OpenedPage | null {
  const incognito = useIncognito();
  const tab = useSelectedTab();
  const initialText = useSearchInitialText();
  const opened = useRef<OpenedPage | null>(null);
  if (!tab || !initialText || tab.isPrivate !== incognito) return null;
  const key = `${tab.id}\n${initialText}`;
  if (opened.current?.key !== key) opened.current = { key, url: tab.url, title: tab.title || initialText, faviconUrl: tab.faviconUrl, initialText };
  return opened.current;
}

function CurrentPageRow({ page }: { page: OpenedPage }) {
  const theme = useTrayTheme();
  const { url, title, faviconUrl, initialText } = page;
  return (
    <Pressable testID="trayCurrentPage" accessibilityRole="button" accessibilityLabel={`Edit ${title}`} accessibilityHint="Puts this page's address in the search field" onPress={() => setSearchText(initialText)} style={({ pressed }) => [styles.searchPanelRow, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
      <View style={styles.searchPanelIcon}>
        <Favicon iconUrl={faviconUrl} pageUrl={url} size={searchPanel.iconSlot} />
      </View>
      <Text numberOfLines={1} style={[styles.searchPanelTitle, { color: theme.foregroundPrimary }]}>
        {title}
      </Text>
      <View style={[styles.searchPanelTrailing, styles.refineArrow]}>
        <Symbol name="arrowUpForward" size={searchPanel.trailingGlyph} color={theme.rowIcon} />
      </View>
      <Pressable testID="trayCurrentPageCopy" accessibilityRole="button" accessibilityLabel="Copy Link" hitSlop={space.xs} onPress={() => copyLink(url)} style={styles.searchPanelTrailing}>
        <SystemGlyph systemName="doc.on.doc" pointSize={searchPanel.trailingGlyph} weight="medium" name="docOnDoc" size={searchPanel.trailingGlyph} color={theme.rowIcon} />
      </Pressable>
    </Pressable>
  );
}

type ScrubbedProps = {
  rows: readonly TrayRow[];
  typed: string;
  budget: number;
  onRefine: (row: TrayRow) => void;
  onMenu: (row: TrayRow, at: Point) => void;
  onContentHeight: (height: number) => void;
};

function ScrubbedRows({ rows, typed, budget, onRefine, onMenu, onContentHeight }: ScrubbedProps) {
  const leaving = useLeavingActions();
  const theme = useTrayTheme();
  const latest = useRef({ rows, budget });
  latest.current = { rows, budget };
  const measured = useRef<(RowFrame | null)[]>([]);
  const [, remeasured] = useState(0);
  const frames = useSharedValue<(RowFrame | null)[]>([]);
  const scrub = useSharedValue<ScrubState>(idleScrub);
  const menuTaken = useSharedValue(false);
  const drawn = useSharedValue(-1);
  const alpha = useSharedValue(0);
  useEffect(() => {
    measured.current = measured.current.slice(0, rows.length);
    frames.value = [...measured.current];
  }, [rows]);

  const release = (index: number) => {
    const row = latest.current.rows[index];
    if (!row) return;
    const frame = measured.current[index];
    if (frame && rowsOverflow(frame.bottom, latest.current.budget) && !useTabs.getState().incognito) countUsage("tray_hidden_rows_opened");
    haptics.confirm();
    leaving.activate(row);
  };
  const tick = () => haptics.selection();
  const openMenu = useCallback(
    (row: TrayRow, at: Point) => {
      menuTaken.value = true;
      scrub.value = idleScrub;
      onMenu(row, at);
    },
    [onMenu],
  );
  const incognito = useIncognito();
  const menus = useMemo(() => rows.map(trayRowActions), [rows, incognito]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withTestId("trayRowsScrub")
        .maxPointers(1)
        .minDistance(SCRUB.distance)
        .onBegin((event) => {
          scrub.value = scrubBegin(frames.value, event.x, event.y);
          menuTaken.value = false;
        })
        .onUpdate((event) => {
          if (menuTaken.value) return;
          const moved = scrubMove(scrub.value, frames.value, event.x, event.y);
          scrub.value = moved.state;
          if (moved.ticks) runOnJS(tick)();
        })
        .onEnd((event) => {
          if (menuTaken.value) return;
          const ended = scrubEnd({ ...scrub.value, scrubbing: true }, frames.value, event.x, event.y);
          if (ended.kind === "activate") runOnJS(release)(ended.index);
        })
        .onFinalize(() => {
          scrub.value = idleScrub;
        }),
    [],
  );

  useAnimatedReaction(
    () => scrub.value.highlighted,
    (index, previous) => {
      if (index === previous) return;
      if (index >= 0) {
        const appearing = drawn.value < 0 || alpha.value < 0.01;
        drawn.value = index;
        alpha.value = appearing ? withSpring(1, trayMotion.press) : 1;
        return;
      }
      alpha.value = withSpring(0, trayMotion.press, (finished) => {
        if (finished) drawn.value = -1;
      });
    },
  );
  const highlightStyle = useAnimatedStyle(() => {
    const frame = drawn.value >= 0 ? frames.value[drawn.value] : null;
    if (!frame) return { opacity: 0 };
    return { opacity: alpha.value, top: frame.top, left: frame.left, width: frame.right - frame.left, height: frame.bottom - frame.top };
  });

  const lastFrame = measured.current[rows.length - 1];
  const contentBottom = lastFrame ? lastFrame.bottom + space.s : 0;
  useEffect(() => {
    if (contentBottom > 0) onContentHeight(contentBottom);
  }, [contentBottom]);
  const overflows = rowsOverflow(lastFrame?.bottom ?? 0, budget);
  const fadesNatively = overflows && fadeIsNative();
  return (
    <GestureDetector gesture={gesture}>
      <FadeView
        testID="trayRowList"
        bottom={fadesNatively ? rowsFadeEdge(budget) : undefined}
        style={[styles.rowsContent, { height: budget > 0 ? budget : undefined, overflow: "hidden" }]}
        collapsable={false}
      >
        <Animated.View pointerEvents="none" style={[styles.highlight, { backgroundColor: theme.rowHighlight }, highlightStyle]} />
        {rows.map((row, index) => (
          <View
            key={index}
            testID={`trayRow:${index}`}
            style={overflows && !fadesNatively && measured.current[index] ? { opacity: rowFade(measured.current[index]!.top, measured.current[index]!.bottom, budget, true) } : null}
            onLayout={(event) => {
              const { x, y, width, height } = event.nativeEvent.layout;
              const was = measured.current[index];
              measured.current[index] = { left: x, top: y, right: x + width, bottom: y + height };
              frames.value = [...measured.current];
              if (!was || was.top !== y || was.bottom !== y + height) remeasured((count) => count + 1);
            }}
          >
            <SuggestionRow row={row} typed={typed} roles={theme} highlightsPress={false} menu={menus[index]} onActivate={leaving.activate} onRefine={onRefine} onMenu={openMenu} />
          </View>
        ))}
      </FadeView>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    elevation: trayShadow.elevation,
    overflow: "hidden",
  },
  fieldArea: { paddingHorizontal: browseLayout.searchFieldInset, paddingTop: browseLayout.trayFieldTop, paddingBottom: space.s },
  panel: {
    position: "absolute",
    left: floatingPanelLayout.inset,
    right: floatingPanelLayout.inset,
    bottom: floatingPanelLayout.aboveKeyboard,
    borderRadius: floatingPanelLayout.panelRadius,
    ...smoothCorners,
  },
  panelFieldLight: { backgroundColor: floatingPanelLayout.fieldLight.fill, borderColor: floatingPanelLayout.fieldLight.edge, borderWidth: floatingPanelLayout.fieldEdge },
  panelFieldDark: { backgroundColor: floatingPanelLayout.fieldDark.fill, borderColor: floatingPanelLayout.fieldDark.edge, borderWidth: floatingPanelLayout.fieldEdge },
  panelFieldArea: { paddingHorizontal: floatingPanelLayout.fieldInset, paddingTop: floatingPanelLayout.fieldInset, paddingBottom: space.xs },
  panelFace: { borderRadius: floatingPanelLayout.panelRadius, borderWidth: StyleSheet.hairlineWidth, ...smoothCorners },
  panelClip: { borderRadius: floatingPanelLayout.panelRadius, overflow: "hidden", ...smoothCorners },
  panelField: { gap: space.s },
  newTabFieldRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  newTabField: { flex: 1 },
  panelInput: { minHeight: browseLayout.searchFieldHeight - floatingPanelLayout.fieldEdge * 2 },
  panelIncognito: { paddingRight: space.xs + 2 },
  incognitoGlyph: { width: INCOGNITO_GLYPH, alignItems: "center", justifyContent: "center" },
  incognitoPlate: {
    position: "absolute",
    width: INCOGNITO_PLATE,
    height: INCOGNITO_PLATE,
    borderRadius: capsule(INCOGNITO_PLATE),
    borderCurve: "continuous",
    backgroundColor: floatingPanelLayout.fieldDark.fill,
  },
  field: {
    minHeight: browseLayout.searchFieldHeight,
    borderRadius: capsule(browseLayout.searchFieldHeight),
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: browseLayout.fieldLeading,
    paddingRight: browseLayout.fieldTrailing,
  },
  fieldContents: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center" },
  input: { flex: 1, paddingVertical: 0, minHeight: browseLayout.searchFieldHeight },
  leavingText: { textAlignVertical: "center", lineHeight: browseLayout.searchFieldHeight },
  accessory: { width: browseLayout.accessory.width, height: browseLayout.accessory.height, alignItems: "center", justifyContent: "center" },
  rows: { flex: 1 },
  stagePanel: { position: "absolute", left: 0, right: 0 },
  stageCard: { paddingHorizontal: floatingPanelLayout.inset, paddingBottom: floatingPanelLayout.aboveKeyboard },
  stageSurface: { borderRadius: floatingPanelLayout.panelRadius, ...smoothCorners },
  incognito: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 36,
    minHeight: 40,
    justifyContent: "flex-end",
    paddingLeft: space.xs + 2,
  },
  incognitoNote: { alignItems: "center", justifyContent: "center", paddingHorizontal: space.l },
  semibold: { fontWeight: "600" },
  centered: { textAlign: "center" },
  rowsContent: { paddingHorizontal: space.s, paddingBottom: space.s },
  searchPanelSheet: { position: "absolute" },
  searchPanelSurface: { borderTopLeftRadius: searchPanel.radius, borderTopRightRadius: searchPanel.radius, ...smoothCorners },
  searchPanelFace: { borderTopLeftRadius: searchPanel.radius, borderTopRightRadius: searchPanel.radius, ...smoothCorners },
  searchPanelClip: { borderTopLeftRadius: searchPanel.radius, borderTopRightRadius: searchPanel.radius, overflow: "hidden", ...smoothCorners },
  searchPanelFieldArea: { paddingHorizontal: searchPanel.fieldSide, paddingTop: searchPanel.fieldTop, paddingBottom: searchPanel.rowsTop },
  searchPanelField: {
    minHeight: searchPanel.fieldHeight,
    borderRadius: capsule(searchPanel.fieldHeight),
    borderWidth: searchPanel.fieldEdge,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: searchPanel.fieldLeading,
    paddingRight: searchPanel.fieldTrailing,
    ...smoothCorners,
  },
  searchPanelInput: { flex: 1, paddingVertical: 0, minHeight: searchPanel.fieldHeight - searchPanel.fieldEdge * 2 },
  panelIncognitoToggle: { flexDirection: "row", alignItems: "center", gap: searchPanel.eyesGap, minHeight: 40, paddingLeft: space.xs, paddingRight: space.xs },
  panelIncognitoLabel: { fontSize: searchPanel.incognitoLabel, fontWeight: "600" },
  searchPanelWeight: { fontWeight: "500" },
  searchPanelRowsContent: { paddingHorizontal: searchPanel.rowInset, paddingBottom: searchPanel.bottom },
  searchPanelRow: { minHeight: searchPanel.rowPitch, flexDirection: "row", alignItems: "center", gap: searchPanel.iconGap, paddingLeft: searchPanel.rowLeading, paddingRight: searchPanel.rowTrailing - space.s, borderRadius: radius.row, ...smoothCorners },
  searchPanelIcon: { width: searchPanel.iconSlot, height: searchPanel.iconSlot, alignItems: "center", justifyContent: "center" },
  searchPanelTitle: { flex: 1, fontSize: searchPanel.titleSize },
  searchPanelTrailing: { width: searchPanel.trailingHit, height: searchPanel.rowPitch, alignItems: "center", justifyContent: "center" },
  refineArrow: { transform: [{ rotate: "-90deg" }] },
  searchPanelCaption: { fontSize: searchPanel.captionSize, fontWeight: "500" },
  highlight: { position: "absolute", borderRadius: radius.row, ...smoothCorners },
});
