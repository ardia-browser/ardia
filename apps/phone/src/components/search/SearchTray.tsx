import { probes } from "../../state/app/launchFlags";
import { createContext, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { labTrace, markShownFrame, traceSlice } from "../../platform/lab";
import { hardwareKeyboardShown } from "@ardia/phone-native";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { FabricCatchUp } from "../ui/FabricCatchUp";
import { countRender } from "../../state/app/interactionPerf";
import { AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { SheetScrollContext, SheetScrollView, sheetPullTranslation, type SheetScroll } from "../ui/Sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, FadeIn, FadeOut, runOnJS, runOnUI, useAnimatedProps, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import type { GestureType } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activateRow, cancelSearch, submitSearch, toggleTrayIncognito } from "../../state/browse/store";
import { copyLink, menuOpenedHaptic, trayRowActions, trayRowHoldAction, type RowAction } from "../../state/browse/tabMenus";
import { rowMenuItems, useRowConfirm } from "./rowConfirm";
import { useSearchEditsPage, useSearchFieldVersion, useSearchInitialText, useSearchOpen, useSearchOrigin, useSearchRows, useSearchSession, useSearchText } from "../../state/search/hooks";
import { SEARCH_ANCHOR_ID, SEARCH_FACE_ID, SEARCH_FIELD_ID, SEARCH_REVEAL_ID, SEARCH_ROWS_REVEAL_ID, setStageMorphs, stageExit, stageOpened, stagePresented, stageSettled, useStageBar } from "../../state/search/stageBar";
import { SearchStage, SearchStagePanel, searchStageIsNative, type SearchStageHandle, type SearchStageLift } from "../../platform/searchStage";
import { useScreenLayout } from "../../state/app/screenLayout";
import { isOpenDuo } from "../../lib/bottomBarSpan";
import { initialPresence, presenceSettled, presenceShown, presenceTarget } from "../../lib/sheetPresence";
import { clampedProgress, keyboardIsUp, keyboardProgress, liveLift, TRAY_LIFT, trayDragDismisses, trayDragOffset, trayDragReleasesKeyboard, trayDragTranslation, trayOffset, trayVelocity } from "../../lib/trayMotion";
import { useOnboarding } from "../../state/onboarding/store";
import { useVoice } from "../../state/voice/store";
import { idleScrub, SCRUB, scrubBegin, scrubEnd, scrubMove, type RowFrame, type ScrubState } from "../../lib/trayScrub";
import { rowFade, rowsFadeEdge, rowsOverflow, wholeRowsHeight } from "../../lib/trayRows";
import { haptics } from "../../state/app/haptics";
import { refinedText, type TrayRow } from "../../state/search/omnibox";
import { adoptStandby, closeEarlyReveal, dropEarlyStandby, earlyRevealWithdrawn, nextStandbyGeneration, NOT_PREPARED, PLUS_ORIGIN, prepareStandby, pressedReveal, refuseEarlyReveal, shownForGeneration, standbyAdopted, standbyShownEarly, unprepareStandby, useStandbyLayout, whenPressRefused } from "../../state/search/standbyReveal";
import { deckTurn, usePhoneTurn } from "../../state/browse/deckTurn";
import { completingFieldIsNative } from "../../platform/completingField";
import { UiFrameMark, uiFrameMarkStyle } from "../ui/UiFrameMark";
import { preparedIdleKey, preparedIdleRows, searchPresented, searchState, setSearchClearsPagePrefill, setSearchText, typeSearch, warmSearchWhenIdle, whenSearchPresents, type SearchOrigin, type SearchPresenting } from "../../state/search/store";
import { useBrowse } from "../../state/browse/store";
import { endSearchTiming, markSearchClosePhase, markSearchPhase } from "../../state/search/searchTiming";
import { coverTray, followTrayBack, trayBackTravel, useTrayCovers } from "../../state/search/trayBack";
import { useIncognito, useSelectedTab, useSelectedTabId } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage, reportLaunchTray } from "../../state/telemetry/telemetry";
import { browseLayout, closingGate, departBezier, shadowCss, DeckLookBackdrop, Favicon, FieldAccessory, iconRoles, smoothCorners, FloatingMenu, font, ink, LookFrost, MotionView, moveTo, radius, screenReaderActions, type MotionCurve, type MotionTarget, trayLandingDelayMs, space, stageMotion, barReturnMotion, slotAround, Symbol, SURFACES_FROST, tabsCurve, stroke, tabsInk, tabsLayout, Tappable, ToggleIconButton, trayMotion, trayShadow, useTheme, FadeView, fadeIsNative, floatingPanelLayout, useDesign, useReduceMotion } from "../ui";
import { plateMaterial, SEARCH_PANEL_FACE, useSolidChrome, usesGlass, type PlateMaterial } from "../ui/LookViews";
import { actionWords } from "../../lib/sharedWords";
import { panelRowLayout, panelTitleLines, SuggestionRow } from "./SuggestionRow";
import { MaterialSearchTray } from "./MaterialSearchView";
import { PanelPins, usePanelPins } from "./NewTabPins";
import { TrayInput, type TrayInputHandle } from "./TrayInput";
import { canSearchByVoice } from "../../state/voice/store";
import { presentVoiceSearchFrom } from "./VoiceSearchView";
import { commandBarMotion, commandPanelPlace, useCommandBar } from "../duo/CommandBar";

const LARGE_FONT_SCALE = 1.5;
import { useTrayKeyboard } from "./useTrayKeyboard";
import { tabSwitchCuts } from "../../state/browse/tabSwitch";
import { useKeyboardTopFromBottom } from "./useKeyboardHeight";
import { chromeInk, chromeLayout, nativeClassicChrome } from "../ui/tokens";
import { incognitoTheme, type Theme } from "../ui/theme";
import { searchFieldHeight, searchFieldInnerHeight, searchFieldRadius, searchPanel, searchPanelFieldCenter, searchPanelInk, searchPanelPlace, searchPanelPlacement, searchPanelRadius, searchTrayHeight, type SearchPanelCorners, type SearchPanelPlace } from "./searchPanelTokens";
import type { Point } from "../../lib/menuPlace";


type TrayList = { drag: GestureType; scroll: SheetScroll };

const TrayListContext = createContext<TrayList | null>(null);

export const SearchPanelContext = createContext(false);

export const searchPanelShown = (phoneLayout: boolean, commandBar: boolean) => phoneLayout && !commandBar;

const INCOGNITO_CAPTION_ROWS = 2;

const ROWS_FALLBACK = 5;

export const panelCornerStyle = (panelRadius: number, corners: SearchPanelCorners) =>
  corners === "top" ? { borderTopLeftRadius: panelRadius, borderTopRightRadius: panelRadius, ...smoothCorners } : { borderRadius: panelRadius, ...smoothCorners };

const panelFill = (incognito: boolean, dark: boolean, solid: boolean) => {
  const panelInk = searchPanelInk(incognito, dark);
  return solid ? panelInk.solid : panelInk.tint;
};

export const searchPanelMorphLook = (incognito: boolean, dark: boolean, material: PlateMaterial) => ({ usesGlass: material === "glass", panelTint: ink.clear, panelDark: incognito, classicPanel: panelFill(incognito, dark, material === "solid"), frosted: material === "frost", classicChrome: nativeClassicChrome });

export const searchPanelSolidFace = (incognito: boolean, dark: boolean) => ({ backgroundColor: panelFill(incognito, dark, true), borderWidth: chromeLayout.edge, borderColor: (incognito || dark ? chromeInk.dark : chromeInk.light).edge });

function SearchPanelFace({ incognito, dark, panelRadius, corners, waiting = false }: { incognito: boolean; dark: boolean; panelRadius: number; corners: SearchPanelCorners; waiting?: boolean }) {
  const solid = plateMaterial(SEARCH_PANEL_FACE, useSolidChrome(), usesGlass()) === "solid";
  const fill = panelFill(incognito, dark, solid);
  const place = [StyleSheet.absoluteFill, panelCornerStyle(panelRadius, corners)];
  if (solid || waiting) return <View testID="searchPanelFace" pointerEvents="none" style={[place, searchPanelSolidFace(incognito, dark)]} />;
  return (
    <View testID="searchPanelFace" pointerEvents="none" style={[place, styles.clip]}>
      <LookFrost source={SURFACES_FROST} variant="thin" cornerRadius={0} fill={ink.clear} dark={incognito || dark} incognito={incognito} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
    </View>
  );
}

const stagedContentLaidOut = () => markSearchPhase("laidOut");

const clearPagePrefill = () => {
  const now = searchState();
  if (now.open && now.editsPage && now.initialText && now.text === now.initialText && now.fieldVersion === 0) setSearchText("");
};

const TrayContentContext = createContext<(height: number) => void>(() => undefined);

const reportRowsHeight = (report: (height: number) => void, height: number) => report(Math.ceil(height));

export const trayThemeFor = (base: Theme, incognito: boolean) => (incognito ? { ...incognitoTheme(base), surface: tabsInk.incognitoSheet } : base);

function useTrayTheme() {
  const base = useTheme();
  const incognito = useIncognito();
  return useMemo(() => trayThemeFor(base, incognito), [base, incognito]);
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
  const presentation = useRef(0);
  const steppedFor = useRef(target);
  const [, redraw] = useState(0);
  if (steppedFor.current !== target) {
    steppedFor.current = target;
    const wasClosing = presence.current.target === null && presence.current.mounted !== null;
    const step = presenceTarget(presence.current, target);
    presence.current = step.presence;
    if (step.motion === "in" && (step.fromHidden || wasClosing)) presentation.current += 1;
  }
  useEffect(() => {
    if (!tabSwitchCuts()) return;
    whenSearchPresents(revealStandbyFor);
    return () => whenSearchPresents(null);
  }, []);
  const standby = tabSwitchCuts() && !probes("tray") ? <TrayLayer key={presentation.current + 1} session={STANDBY_SESSION} closing={false} standby onClosed={noClose} /> : null;
  const shown = target ?? presenceShown(presence.current);
  if (shown === null) return standby;
  const closed = () => {
    const next = presenceSettled(presence.current, presence.current.generation, true);
    if (next === presence.current) return;
    presence.current = next;
    redraw((count) => count + 1);
  };
  return <TrayLayer key={presentation.current} session={shown} closing={target === null} onClosed={closed} />;
}

const STANDBY_SESSION = -1;

let revealStandby: ((presenting: SearchPresenting) => string | null) | null = null;
let standbyField: TrayInputHandle | null = null;
let standbyRowsKey: string | null = null;
let standbyTyped = "";
let standbyKeptText: string | null = null;
let standbyArmed = 0;
let standbyGo: { generation: number; text: string } | null = null;
let adoptedGo: string | null = null;

const holdStandbyGo = (text: string) => {
  const shown = standbyShownEarly.value;
  if (standbyArmed === 0 || shown.generation !== standbyArmed || shown.press === 0) return false;
  standbyGo = { generation: standbyArmed, text };
  return true;
};

const takeAdoptedGo = () => {
  const go = adoptedGo;
  adoptedGo = null;
  return go;
};

const revealStandbyFor = (presenting: SearchPresenting): string | null => {
  if (presenting.text === "" && revealStandby) return revealStandby(presenting);
  refuseEarlyReveal(pressedReveal());
  return null;
};

const StandbyContext = createContext(false);

const FieldOwnerContext = createContext<() => boolean>(() => searchState().open);

const useTrayOrigin = (standby: boolean): SearchOrigin => {
  const live = useSearchOrigin();
  const prepared = useBrowse((state) => (state.surface === "start" ? "start" : "page"));
  return standby ? prepared : live;
};

const noClose = () => undefined;

type LayerProps = { session: number; closing: boolean; standby?: boolean; onClosed: () => void };

const FIRST_KEYBOARD_SHARE = 0.42;

const firstLift = (rememberedKeyboard: number, windowHeight: number) => (hardwareKeyboardShown() || rememberedKeyboard > TRAY_LIFT.keyboardThreshold ? 0 : windowHeight * FIRST_KEYBOARD_SHARE);

function TrayLayer({ session, closing, standby = false, onClosed }: LayerProps) {
  countRender("TrayLayer");
  const origin = useTrayOrigin(standby);
  const theme = useTrayTheme();
  const incognito = useIncognito();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const keyboard = useTrayKeyboard();
  const arrivesAtRest = useRef(searchState().arrival === "atRest").current;
  const cutsIn = useRef(tabSwitchCuts() && !closing).current;
  const bornStandby = useRef(standby).current;
  const keepsField = useRef<boolean | null>(null);
  if (bornStandby && !standby && keepsField.current === null) keepsField.current = searchState().text === (standbyKeptText ?? "");
  const fieldKey = bornStandby && keepsField.current !== false ? "kept" : String(session);
  const landing = useSharedValue(arrivesAtRest || cutsIn ? 1 : 0);
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
  const hasLanded = useSharedValue(arrivesAtRest || cutsIn);
  const isClosing = useSharedValue(closing);
  const dim = useSharedValue(cutsIn ? 1 : 0);
  const pinned = useSharedValue(cutsIn);
  const floor = useSharedValue(0);
  const tabId = useSelectedTabId();
  const standbyLayout = useStandbyLayout();
  const phone = usePhoneTurn((state) => state.generation);
  const armed = useSharedValue(0);
  const armedNow = useRef(0);
  const revealed = useSharedValue(0);
  const [furnished, setFurnished] = useState(!bornStandby);
  const shownNow = useDerivedValue(() => shownForGeneration(armed.value, standbyShownEarly.value, revealed.value, deckTurn.live.value, deckTurn.appliedTurn.value));
  const revealStyle = useAnimatedStyle(() => ({ opacity: !standby || shownNow.value ? 1 : 0 }));
  const revealProps = useAnimatedProps<{ pointerEvents: "box-none" | "none"; importantForAccessibility: "auto" | "no-hide-descendants" }>(() => {
    const shown = shownNow.value;
    if (!standby) return { pointerEvents: closing ? "none" : "box-none", importantForAccessibility: closing ? "no-hide-descendants" : "auto" };
    return { pointerEvents: shown ? "box-none" : "none", importantForAccessibility: shown ? "auto" : "no-hide-descendants" };
  });
  const fieldReveal = useDerivedValue(() => (shownNow.value ? armed.value : 0));
  const shownMark = useAnimatedProps(() => ({ markWhenShown: armed.value !== 0 ? `search-ui:${armed.value}` : "" }));
  useAnimatedReaction(
    () => (shownNow.value && revealed.value !== armed.value ? armed.value : 0),
    (early, was) => {
      if (was && early !== was && revealed.value !== was) runOnJS(earlyRevealWithdrawn)(was);
    },
  );
  useLayoutEffect(() => {
    if (!standby) {
      if (bornStandby && revealed.value !== armedNow.current) revealed.value = armedNow.current;
      return;
    }
    if (cutsIn) floor.value = firstLift(keyboard.full.value, window.height);
    traceSlice("standby ready");
    const generation = nextStandbyGeneration();
    armedNow.current = generation;
    armed.value = generation;
    revealed.value = 0;
    standbyTyped = "";
    standbyKeptText = null;
    standbyArmed = generation;
    standbyGo = null;
    const armedSession = searchState().session;
    prepareStandby(origin === PLUS_ORIGIN && tabId !== null ? { generation, tabId, layout: standbyLayout, incognito, origin, phone } : NOT_PREPARED);
    const discardDraft = (refused: number) => {
      if (refused !== generation) return;
      standbyTyped = "";
      if (standbyGo?.generation === generation) standbyGo = null;
      standbyField?.discardDraft();
    };
    whenPressRefused(discardDraft);
    revealStandby = (presenting) => {
      const early = pressedReveal();
      const otherSheet = early.press !== 0 && early.generation !== generation;
      const shownByPress = early.press !== 0 && early.generation === generation;
      const rowsDiffer = presenting.prepared !== standbyRowsKey && !shownByPress;
      if (otherSheet || rowsDiffer || presenting.origin !== origin || presenting.incognito !== incognito || presenting.editsPage || searchState().session !== armedSession) {
        if (early.press !== 0) dropEarlyStandby(early.press);
        discardDraft(generation);
        return null;
      }
      traceSlice("search reveal");
      adoptStandby(generation);
      revealed.value = generation;
      adoptedGo = standbyGo?.generation === generation ? standbyGo.text : null;
      standbyGo = null;
      if (!completingFieldIsNative()) {
        standbyField?.focus();
        markShownFrame("search");
      }
      standbyKeptText = standbyTyped;
      return standbyTyped;
    };
    return () => {
      revealStandby = null;
      whenPressRefused(null);
      if (standbyArmed === generation) standbyArmed = 0;
      unprepareStandby(generation);
    };
  }, [standby, origin, incognito, tabId, standbyLayout, phone]);
  useEffect(() => {
    if (standby || furnished) return;
    const frame = requestAnimationFrame(() => setFurnished(true));
    return () => cancelAnimationFrame(frame);
  }, [standby, furnished]);
  const drag = useSharedValue(0);
  const dragging = useSharedValue(false);
  const released = useSharedValue(false);
  const heldLift = useSharedValue(-1);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safeBottom = insets.bottom;
  const panel = useDesign() === "redesigned";
  const commandPlacement = useCommandBar(Math.max(keyboard.target, safeBottom));
  const command = panel ? commandPlacement : null;
  const arcPanel = panel && command === null;
  const fieldHeight = searchFieldHeight(window.fontScale);
  const panelRadius = searchPanelRadius(fieldHeight);
  const resting = Math.max(keyboard.target, safeBottom);
  const placement = searchPanelPlacement(arcPanel, command !== null);
  const place = searchPanelPlace(placement, resting);
  const corners = place.corners;
  const [rowsHeight, setRowsHeight] = useState(ROWS_FALLBACK * browseLayout.suggestionPitch * window.fontScale);
  const measuredRows = useCallback((height: number) => setRowsHeight((was) => (Math.abs(was - height) < 1 ? was : height)), []);
  useLayoutEffect(() => {
    if (arcPanel && !closing && !standby) clearPagePrefill();
  }, [standby]);
  useLayoutEffect(() => {
    if (!standby) setSearchClearsPagePrefill(arcPanel);
  }, [arcPanel, standby]);
  const baseTrayHeight = searchTrayHeight({ commandBarMaxHeight: command?.maxHeight ?? null, placement, place, fieldHeight, fontScale: window.fontScale, rowsHeight, windowHeight: window.height, safeTop: insets.top, resting });
  const pinsBlock = usePanelPins({ closing, room: arcPanel && !standby && furnished ? pinsRoom(window.height, insets.top, place, resting, baseTrayHeight) : 0 });
  const trayHeight = baseTrayHeight + pinsBlock.height;
  const extend = placement === "underKeyboard" ? window.height : 0;
  const closedOnPressIn = useRef(false);
  const closeFromTouch = (): boolean => {
    const now = searchState();
    const generation = armedNow.current;
    const waiting = session === STANDBY_SESSION;
    const mine = now.open && (waiting ? standbyAdopted(generation) : now.session === session);
    labTrace(`PAGELAB search dim ${waiting ? "waiting" : "live"} open=${now.open} mine=${mine}`);
    if (mine) cancelSearch();
    if (waiting) closeEarlyReveal(generation);
    return mine;
  };
  const ownsField = useCallback(() => {
    const now = searchState();
    if (!now.open) return false;
    return session === STANDBY_SESSION ? standbyAdopted(armedNow.current) : now.session === session;
  }, [session]);
  const closeOnPressIn = () => {
    closedOnPressIn.current = closeFromTouch();
  };
  const closeOnPress = () => {
    if (closedOnPressIn.current) {
      closedOnPressIn.current = false;
      return;
    }
    closeFromTouch();
  };

  useEffect(() => {
    if (closing || standby) return;
    isClosing.value = false;
    const progress = keyboardProgress(keyboard.height.value, keyboard.full.value, 0);
    const landed = arrivesAtRest || cutsIn || (keyboardIsUp(keyboard.height.value) && progress >= TRAY_LIFT.landedProgress);
    hasLanded.value = landed;
    landing.value = landed ? 1 : 0;
    if (cutsIn) {
      dim.value = 1;
      pinned.value = true;
      floor.value = firstLift(keyboard.full.value, window.height);
      if (!arrivesAtRest && searchState().arrival === "atRest") launchTrayUp();
      return;
    }
    const land = setTimeout(() => {
      if (isClosing.value || hasLanded.value) return;
      hasLanded.value = true;
      landing.value = reduceMotion ? withTiming(1, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }) : moveTo(1, trayMotion.rise);
    }, trayLandingDelayMs);
    return () => clearTimeout(land);
  }, [session, closing, standby]);

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
    if (closing || standby) return;
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
      if (isClosing.value || progress < TRAY_LIFT.landedProgress) return;
      pinned.value = false;
      floor.value = 0;
      if (hasLanded.value) return;
      hasLanded.value = true;
      landing.value = 1;
    },
  );

  useAnimatedReaction(
    () => !isClosing.value && (keyboardIsUp(keyboard.height.value) || hasLanded.value),
    (up, was) => {
      if (up === was) return;
      if (up && arrivesAtRest) runOnJS(launchTrayUp)();
      if (up && cutsIn) {
        dim.value = 1;
        return;
      }
      dim.value = withTiming(up ? 1 : 0, { duration: reduceMotion ? trayMotion.reduced : trayMotion.dim, easing: reduceMotion ? tabsCurve.easeOut : trayMotion.dimEasing });
    },
  );

  const liftOf = (held: number, height: number, full: number, landed: boolean, closingNow: boolean, pinnedNow: boolean, floorNow: number) => {
    "worklet";
    if (held >= 0) return held;
    const live = liveLift(height, safeBottom, landed, closingNow);
    if (closingNow) return live;
    return Math.max(pinnedNow ? Math.max(live, full) : live, floorNow);
  };
  const currentLift = () => {
    "worklet";
    return liftOf(heldLift.value, keyboard.height.value, keyboard.full.value, hasLanded.value, isClosing.value, pinned.value, floor.value);
  };
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value * (1 - clampedProgress(drag.value, trayHeight + liftOf(heldLift.value, keyboard.height.value, keyboard.full.value, hasLanded.value, isClosing.value, pinned.value, floor.value))) }), [trayHeight, safeBottom]);
  const covered = useTrayCovers((state) => state.covers > 0);
  const voicePresented = useVoice((state) => state.presented);
  const trayOnTop = !closing && !covered && !voicePresented && !standby;
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
  const trayMotionNow = () => {
    "worklet";
    return landing.value + keyboard.height.value + keyboard.full.value + drag.value + back.value + heldLift.value + dim.value;
  };
  const trayStyle = useAnimatedStyle(() => {
    const lift = liftOf(heldLift.value, keyboard.height.value, keyboard.full.value, hasLanded.value, isClosing.value, pinned.value, floor.value);
    const rise = reduceMotion ? 1 : Math.max(landing.value, keyboardProgress(keyboard.height.value, keyboard.full.value, 0));
    if (command) return commandBarMotion(Math.max(landing.value, keyboardProgress(keyboard.height.value, keyboard.full.value, 0)), dim.value, reduceMotion, drag.value, back.value * trayBackTravel);
    return {
      opacity: reduceMotion ? dim.value : 1,
      transform: [{ translateY: trayOffset(lift, drag.value, rise, trayHeight, panelRadius) + back.value * trayBackTravel }],
    };
  }, [trayHeight, safeBottom, reduceMotion, command !== null, panelRadius]);

  return (
    <StandbyContext.Provider value={standby}>
    <FieldOwnerContext.Provider value={ownsField}>
    <DepartContext.Provider value={beginDeparture}>
    <Animated.View testID={standby ? "trayStandby" : "trayRoot"} style={[StyleSheet.absoluteFill, bornStandby ? revealStyle : null]} animatedProps={bornStandby ? revealProps : undefined} pointerEvents={closing || standby ? "none" : "box-none"} collapsable={false} importantForAccessibility={closing || standby ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={closing || standby}>
      {closing || standby ? null : <FabricCatchUp motion={trayMotionNow} testID="trayFabricCatchUp" />}
      {bornStandby ? <UiFrameMark testID="traySearchUiMark" style={[uiFrameMarkStyle, revealStyle]} animatedProps={shownMark} /> : null}
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
            command ? commandPanelPlace(command, fieldHeight) : [styles.searchPanelSheet, { left: insets.left + place.cardInset, right: insets.right + place.cardInset, bottom: -extend, height: trayHeight + extend }],
            panelCornerStyle(panelRadius, corners),
            { boxShadow: shadowCss("floating", incognito) },
            trayStyle,
          ]}
        >
          <SearchPanelFace incognito={incognito} dark={theme.dark} panelRadius={panelRadius} corners={corners} waiting={standby || !furnished} />
          <View style={[styles.clip, panelCornerStyle(panelRadius, corners), { height: trayHeight }]}>
            <SearchPanelContext.Provider value={arcPanel}>
              <PanelPins block={pinsBlock} closing={closing} onLeave={beginDeparture} />
              <GestureDetector gesture={dismissDrag}>
                <View collapsable={false}>
                  <TrayField key={fieldKey} closing={closing} standby={standby} reveal={fieldKey === "kept" ? fieldReveal : undefined} />
                </View>
              </GestureDetector>
              {standby || !furnished ? <StandbyRowsKey /> : <TrayRows dismissDrag={dismissDrag} />}
            </SearchPanelContext.Provider>
          </View>
        </Animated.View>
        </MotionView>
      ) : (
      <Animated.View
        testID="traySheet"
        style={[
          styles.sheet,
          panelCornerStyle(panelRadius, corners),
          {
            left: insets.left + place.cardInset,
            right: insets.right + place.cardInset,
            bottom: place.cardGap - extend,
            height: trayHeight + extend,
            backgroundColor: incognito ? theme.canvas : ink.clear,
            shadowColor: theme.trayShadow,
            shadowOpacity: trayShadow.opacity,
            shadowRadius: trayShadow.radius,
            shadowOffset: { width: 0, height: trayShadow.offsetY },
          },
          trayStyle,
        ]}
      >
        {incognito ? null : furnished && !standby ? <LookFrost source={SURFACES_FROST} variant="sheet" cornerRadius={panelRadius} fill={theme.canvas} style={StyleSheet.absoluteFill} /> : <View testID="traySheetSolidFace" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas, borderRadius: panelRadius }]} />}
        <View style={{ height: trayHeight }}>
          <TrayContentContext.Provider value={measuredRows}>
            <GestureDetector gesture={dismissDrag}>
              <View collapsable={false}>
                <TrayField key={fieldKey} closing={closing} standby={standby} reveal={fieldKey === "kept" ? fieldReveal : undefined} />
              </View>
            </GestureDetector>
            {standby || !furnished ? <StandbyRowsKey /> : <TrayRows dismissDrag={dismissDrag} />}
          </TrayContentContext.Provider>
        </View>
      </Animated.View>
      )}
    </Animated.View>
    </DepartContext.Provider>
    </FieldOwnerContext.Provider>
    </StandbyContext.Provider>
  );
}


const pinsRoom = (windowHeight: number, safeTop: number, place: SearchPanelPlace, resting: number, baseTrayHeight: number) => Math.max(0, windowHeight - safeTop - place.gapAbove - resting - place.gapAboveKeyboard - baseTrayHeight);

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
  const solid = useSolidChrome();
  const phoneLayout = useScreenLayout((s) => s.layout.name === "phone");
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
  const [fieldHeight, setFieldHeight] = useState(knownFieldHeight || searchFieldHeight(window.fontScale));
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
  const panelRadius = searchPanelRadius(fieldHeight);
  const placement = searchPanelPlacement(arcPanel, command !== null);
  const place = searchPanelPlace(placement, resting);
  const corners = place.corners;
  const baseTrayHeight = searchTrayHeight({ commandBarMaxHeight: command?.maxHeight ?? null, placement, place, fieldHeight, fontScale: window.fontScale, rowsHeight, windowHeight: window.height, safeTop: insets.top, resting });
  const pinsBlock = usePanelPins({ closing, room: mounted !== null && arcPanel && command === null ? pinsRoom(window.height, insets.top, place, resting, baseTrayHeight) : 0 });
  const trayHeight = baseTrayHeight + pinsBlock.height;
  const underKeyboard = place.underKeyboard;
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

  const presentStage = (presentation: number) => {
    markSearchPhase("present");
    live.current.presentation = presentation;
    setPresentation(presentation);
    if (!editsPage && searchPanelShown(phoneLayout, command !== null) && !useTabs.getState().incognito) countUsage("new_tab_search_opened");
    setPresented(false);
    const launch = searchState().arrival === "atRest";
    void stage.current?.present().then(() => {
      if (live.current.presentation !== presentation || live.current.closing) return;
      if (launch) launchTrayUp();
      markSearchPhase("presented");
      setPresented(true);
      stagePresented();
      searchPresented(searchState().session);
    });
  };
  const clearsPrefill = searchPanelShown(phoneLayout, command !== null);
  useLayoutEffect(() => setSearchClearsPagePrefill(clearsPrefill), [clearsPrefill]);
  useEffect(() => {
    const keyboardRises = Keyboard.addListener("keyboardWillShow", () => markSearchPhase("keyboard"));
    return () => keyboardRises.remove();
  }, []);
  useEffect(() => warmSearchWhenIdle(), []);
  useEffect(() => clearHeldRelease, []);

  useLayoutEffect(() => {
    const now = live.current;
    if (open) {
      const presents = now.mounted === null || now.closing;
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
      if (presents) presentStage(now.presentation + 1);
      return;
    }
    if (now.mounted === null || now.closing) return;
    now.closing = true;
    markSearchClosePhase("closing");
    clearHeldRelease();
    setClosing(true);
    setHoldsScroll(true);
    putKeyboardAway();
    const velocity = now.velocity;
    now.velocity = 0;
    stage.current?.close(stageExit(searchState().ending, now.morphs), velocity);
  }, [open, session]);


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

  const settled = ({ landed, path }: { landed: boolean; path?: string }) => {
    const now = live.current;
    if (!now.closing) return;
    now.closing = false;
    now.mounted = null;
    markSearchClosePhase(`${landed ? "landed" : "settled"} ${path ?? "unknown"}`);
    endSearchTiming();
    clearHeldRelease();
    stageSettled(landed);
    setHoldsScroll(false);
    setHandOver((count) => count + 1);
  };

  const landing = ({ lands, path }: { lands: boolean; path: string }) => {
    markSearchClosePhase(`${lands ? "flies" : "stays"} ${path}`);
    if (!lands && live.current.closing) setStageMorphs(false);
  };

  const revealed = ({ late }: { late: boolean }) => {
    markSearchPhase(late ? "revealedLate" : "revealed");
    live.current.revealed = true;
    if (!live.current.closing) setHoldsScroll(false);
    if (late && !useTabs.getState().incognito) countUsage("search_reveals_late");
  };

  const lifted = (next: SearchStageLift) => {
    if (next.up && !next.predicted && next.lift > safeBottom) knownLift = next.lift;
    setLift((was) => (was.lift === next.lift && was.up === next.up ? was : next));
  };
  const dimUp = arcPanel ? !closing : lift.up;
  useEffect(() => {
    dim.value = withTiming(dimUp ? 1 : 0, { duration: reduceMotion ? barReturnMotion.fadeMs : stageMotion.dimMs, easing: tabsCurve.easeOut });
  }, [dimUp]);

  const sizesByRows = mounted !== null && placement === "aboveKeyboard";
  const sizesByRowsNow = useRef(sizesByRows);
  sizesByRowsNow.current = sizesByRows;
  useEffect(() => {
    if (sizesByRows && knownRowsHeight) setRowsHeight((was) => (Math.abs(was - knownRowsHeight) < 1 ? was : knownRowsHeight));
  }, [sizesByRows]);
  const measuredRows = useCallback((height: number) => {
    knownRowsHeight = height;
    if (sizesByRowsNow.current) setRowsHeight((was) => (Math.abs(was - height) < 1 ? was : height));
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
  const panelMaterial = plateMaterial(SEARCH_PANEL_FACE, solid, usesGlass());
  const morphLook = useMemo(() => searchPanelMorphLook(incognito, theme.dark, panelMaterial), [incognito, theme.dark, panelMaterial]);
  const morphCorners = useMemo(() => ({ panel: panelRadius, field: searchFieldRadius(fieldHeight) }), [panelRadius, fieldHeight]);
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
      fieldCenter={searchPanelFieldCenter(fieldHeight) + pinsBlock.height}
      cardInset={place.cardInset}
      cardGap={place.cardGap}
      fieldInset={place.fieldInset}
      fieldTop={place.fieldTop + pinsBlock.height}
      commandTop={command ? command.top : null}
      landsDirectly={landsDirectly}
      morphLook={morphLook}
      morphCorners={morphCorners}
      onLift={lifted}
      onReveal={revealed}
      onSettled={settled}
      onLanding={landing}
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
        {overPage && !solid ? <LookFrost source={SURFACES_FROST} variant="thin" cornerRadius={0} fill={theme.trayDim} dark={incognito || theme.dark} style={StyleSheet.absoluteFill} /> : null}
        {arcPanel && !overPage && !incognito ? <DeckLookBackdrop /> : null}
      </AnimatedPressable>
      <SearchStagePanel testID="trayPanel" pointerEvents="box-none" style={command ? [styles.stagePanel, { top: command.top }] : [styles.stagePanel, { bottom: -underKeyboard }]}>
        <Animated.View testID="trayDrag" collapsable={false} style={dragStyle}>
          {mounted !== null ? (
            <View
              key={presentation}
              style={command ? { marginLeft: command.left, width: command.width } : { paddingLeft: insets.left + place.cardInset, paddingRight: insets.right + place.cardInset, paddingBottom: place.cardGap }}
              testID="trayStagedContent"
              onLayout={stagedContentLaidOut}
              {...closingGate(closing)}
            >
              <View testID="traySurface" style={[panelCornerStyle(panelRadius, corners), { height: trayHeight + underKeyboard, boxShadow: shadowCss("floating", incognito) }]}>
                <SearchPanelFace incognito={incognito} dark={theme.dark} panelRadius={panelRadius} corners={corners} />
                <View style={[styles.clip, panelCornerStyle(panelRadius, corners), { height: trayHeight + underKeyboard }]}>
                  <TrayContentContext.Provider value={measuredRows}>
                  <SearchPanelContext.Provider value={arcPanel}>
                    <TrayListContext.Provider value={arcPanel ? trayList : null}>
                    <PanelPins block={pinsBlock} closing={closing} anchorShift={lift.up ? -lift.lift : 0} />
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
const PANEL_DEPART: MotionCurve = { type: "timing", durationMs: floatingPanelLayout.departMs, curve: [...departBezier] };

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

function TrayField({ closing, standby = false, reveal }: { closing: boolean; standby?: boolean; reveal?: SharedValue<number> }) {
  const live = useSearchFieldVersion();
  const version = standby ? 0 : live;
  return <FieldInput key={version} first={version === 0} closing={closing} standby={standby} reveal={version === 0 ? reveal : undefined} />;
}

function FieldInput({ first, closing, standby = false, reveal }: { first: boolean; closing: boolean; standby?: boolean; reveal?: SharedValue<number> }) {
  const leaving = useLeavingActions();
  const theme = useTrayTheme();
  const panelField = useDesign() === "redesigned";
  const incognitoField = useIncognito();
  const initialText = useSearchInitialText();
  const [start] = useState(() => (standby ? "" : searchState().text));
  const [hasText, setHasText] = useState(start.length > 0);
  const input = useRef<TrayInputHandle | null>(null);
  const submitted = useRef(false);
  const staged = useContext(StagedFieldContext);
  const ownsField = useContext(FieldOwnerContext);

  const [fieldGone, dropField] = useState(false);
  const focusesInCommit = tabSwitchCuts() && !staged;
  useLayoutEffect(() => {
    if (standby || closing || !focusesInCommit) return;
    trayInput = input.current;
    if (reveal && completingFieldIsNative()) return;
    input.current?.focus();
    markShownFrame("search");
  }, [closing, standby]);
  useEffect(() => {
    if (standby) return;
    trayInput = input.current;
    const go = closing || !reveal ? null : takeAdoptedGo();
    if (go !== null && !submitted.current && ownsField() && leaving.submit(go)) submitted.current = true;
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
    if (focusesInCommit) return;
    const focus = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, [closing, staged?.presented, standby]);
  const lastText = useRef(start);
  const { fontScale } = useWindowDimensions();
  const fieldHeight = searchFieldHeight(fontScale);
  const arcInk = searchPanelInk(incognitoField, theme.dark);
  const outerField = { height: fieldHeight, borderRadius: searchFieldRadius(fieldHeight) };
  const capsuleStyle = panelField
    ? [styles.searchPanelField, outerField, { backgroundColor: arcInk.field, borderColor: arcInk.fieldEdge }]
    : [styles.field, outerField, { backgroundColor: theme.fieldFill, borderColor: theme.fieldStroke }];
  const inputHeight = panelField ? searchFieldInnerHeight(fieldHeight) : fieldHeight - stroke.field * 2;
  const inputStyle = [panelField ? styles.searchPanelInput : styles.input, { minHeight: inputHeight }];

  return (
    <View testID={panelField ? "searchPanelFieldRow" : "trayFieldRow"} style={styles.searchPanelFieldArea}>
      <View testID="trayFieldCapsule" onLayout={staged ? (event) => staged.onFieldHeight(event.nativeEvent.layout.height) : undefined} style={capsuleStyle}>
        <View testID="trayFieldReveal" nativeID={staged ? SEARCH_REVEAL_ID : undefined} collapsable={false} style={[styles.fieldContents, panelField ? styles.panelField : null]}>
        {fieldGone ? (
          <Text testID="trayFieldLeaving" numberOfLines={1} maxFontSizeMultiplier={searchPanel.maxTextScale} style={[font.title3, styles.input, styles.leavingText, panelField ? styles.searchPanelWeight : null, { minHeight: inputHeight, lineHeight: inputHeight }, { color: lastText.current ? theme.foregroundPrimary : theme.foregroundTertiary }]}>
            {lastText.current || "Search…"}
          </Text>
        ) : (
        <TrayInput
          ref={(field) => {
            input.current = field;
            if (standby) standbyField = field;
            else trayInput = field;
          }}
          style={inputStyle}
          weight={panelField ? "medium" : "regular"}
          start={start}
          selectsStart={first && Boolean(initialText)}
          color={theme.foregroundPrimary}
          placeholderColor={theme.foregroundTertiary}
          accent={theme.spaceAccentInk}
          keyboardAppearance={incognitoField ? "dark" : "default"}
          holdsScroll={staged?.holdsScroll}
          nativeID={staged ? SEARCH_FIELD_ID : undefined}
          revealFocus={reveal}
          onTyped={(text) => {
            lastText.current = text;
            if (text.length > 0 !== hasText) setHasText(text.length > 0);
            if (!ownsField()) {
              if (standby) standbyTyped = text;
              return;
            }
            typeSearch(text);
          }}
          onSubmit={(text) => {
            if (submitted.current) return;
            if (!ownsField()) {
              if (standby) holdStandbyGo(text);
              return;
            }
            if (leaving.submit(text)) submitted.current = true;
          }}
        />
        )}
        {hasText ? (
          <FieldAccessory
            testID="trayClear"
            icon={iconRoles.clearText}
            label={actionWords.clearText}
            color={theme.foregroundTertiary}
            onPress={() => {
              if (!input.current?.clearsInPlace()) setSearchText("");
            }}
          />
        ) : (
          <VoiceButton />
        )}
        {panelField ? <PanelIncognitoToggle /> : <IncognitoToggle />}
        </View>
      </View>
    </View>
  );
}

function VoiceButton() {
  const theme = useTrayTheme();
  const incognito = useIncognito();
  const { fontScale } = useWindowDimensions();
  const button = useRef<ViewInstance>(null);
  if (incognito || fontScale > LARGE_FONT_SCALE || !canSearchByVoice()) return null;
  return <FieldAccessory testID="trayVoice" buttonRef={button} icon={iconRoles.voice} label={VOICE_SEARCH} color={theme.foregroundTertiary} onPress={() => presentVoiceSearchFrom(() => button.current)} />;
}

const VOICE_SEARCH = "Voice Search";

const INCOGNITO = "Incognito";

function IncognitoToggle() {
  const theme = useTrayTheme();
  const on = useIncognito();
  return (
    <ToggleIconButton testID="trayIncognito" checked={on} onChange={toggleTrayIncognito} label={INCOGNITO} role="switch" visual={searchPanel.eyes}>
      <View testID="trayIncognitoGlyph">
        <IncognitoEyes incognito={on} size={searchPanel.eyes} color={theme.label} />
      </View>
    </ToggleIconButton>
  );
}

function PanelIncognitoToggle() {
  const theme = useTrayTheme();
  const on = useIncognito();
  const { fontScale } = useWindowDimensions();
  return (
    <ToggleIconButton testID="trayIncognito" checked={on} onChange={toggleTrayIncognito} label={INCOGNITO} role="switch" visual={searchPanel.eyes} style={styles.panelIncognitoToggle}>
      {on && fontScale <= LARGE_FONT_SCALE ? (
        <Animated.Text testID="trayIncognitoLabel" entering={modeToggleIn} exiting={modeToggleOut} numberOfLines={1} style={[styles.panelIncognitoLabel, { color: searchPanel.incognito.label }]}>
          {INCOGNITO}
        </Animated.Text>
      ) : null}
      <View testID="trayIncognitoGlyph">
        <IncognitoEyes incognito={on} size={searchPanel.eyes} color={theme.label} />
      </View>
    </ToggleIconButton>
  );
}

function StandbyRowsKey() {
  useIncognito();
  const key = preparedIdleKey();
  useLayoutEffect(() => {
    standbyRowsKey = key;
  });
  return null;
}

function TrayRows({ dismissDrag }: { dismissDrag: GestureType }) {
  const leaving = useLeavingActions();
  const theme = useTrayTheme();
  const standby = useContext(StandbyContext);
  const liveRows = useSearchRows();
  const liveTyped = useSearchText();
  const incognito = useIncognito();
  const preparedKey = standby ? preparedIdleKey() : null;
  const preparedRows = useMemo(() => (standby ? preparedIdleRows() : null), [standby, preparedKey]);
  useLayoutEffect(() => {
    if (standby) standbyRowsKey = preparedKey;
  }, [standby, preparedKey]);
  const rows = preparedRows ?? liveRows;
  const typed = standby ? "" : liveTyped;
  const [room, setRoom] = useState(0);
  const [bottoms, setBottoms] = useState<number[]>([]);
  const refine = useCallback((row: TrayRow) => setSearchText(refinedText(row)), []);
  const [menu, setMenu] = useState<{ row: TrayRow; at: Point } | null>(null);
  const confirm = useRowConfirm();
  const menuOpen = menu !== null;
  useEffect(() => (menuOpen ? coverTray() : undefined), [menuOpen]);
  const window = useWindowDimensions();
  const keyboardTop = useKeyboardTopFromBottom();
  const showMenu = useCallback(
    (row: TrayRow, at: Point) => {
      const hold = trayRowHoldAction(row);
      if (!hold && !trayRowActions(row).length) return;
      menuOpenedHaptic();
      if (hold) confirm.choose(hold);
      else setMenu({ row, at });
    },
    [confirm.choose],
  );
  const arc = useContext(SearchPanelContext);
  const list = useContext(TrayListContext);
  const reportRows = useContext(TrayContentContext);
  const liveEditsPage = useSearchEditsPage();
  const editsPage = standby ? false : liveEditsPage;
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
  const floatingMenu = menu ? (
    <FloatingMenu
      items={rowMenuItems(trayRowActions(menu.row), confirm.choose)}
      at={menu.at}
      floor={keyboardTop ? window.height - keyboardTop : undefined}
      dimmed
      frost={null}
      place={{ width: Math.min(tabsLayout.menuWidth, window.width - space.xl * 2) }}
      onDismiss={() => setMenu(null)}
    />
  ) : null;
  const menuView = (
    <>
      {floatingMenu}
      {confirm.dialog}
    </>
  );
  const measure = (index: number, layout: { y: number; height: number }) => {
    const bottom = layout.y + layout.height;
    setBottoms((known) => (known[index] === bottom ? known : Object.assign([...known], { [index]: bottom })));
  };
  const rowViews = rows.map((row, index) => (
    <View key={index} onLayout={arc ? undefined : (event) => measure(index, event.nativeEvent.layout)}>
      <SuggestionRow row={row} typed={typed} roles={theme} menu={confirm.guarded(trayRowActions(row))} onActivate={leaving.activate} onRefine={refine} onMenu={showMenu} />
    </View>
  ));
  if (window.fontScale <= LARGE_FONT_SCALE && !arc) {
    return (
      <Animated.View key="rows" testID="trayRows" entering={resultsIn} exiting={resultsOut} style={styles.rows} onLayout={(event) => setRoom(event.nativeEvent.layout.height)}>
        <ScrubbedRows rows={rows} typed={typed} budget={room} guard={confirm.guarded} onRefine={refine} onMenu={showMenu} onContentHeight={(height) => reportRowsHeight(reportRows, height)} />
        {menuView}
      </Animated.View>
    );
  }
  return (
    <Animated.View key="rows" testID={arc ? "searchPanelRows" : undefined} entering={resultsIn} exiting={resultsOut} style={styles.rows} onLayout={arc ? undefined : (event) => setRoom(event.nativeEvent.layout.height)}>
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

const EDIT_PAGE_HINT = "Puts this page’s address in the search field.";

function CurrentPageRow({ page }: { page: OpenedPage }) {
  const theme = useTrayTheme();
  const lines = panelTitleLines(useWindowDimensions().fontScale);
  const { url, title, faviconUrl, initialText } = page;
  return (
    <View testID="trayCurrentPageRow" style={styles.currentPage}>
      <Pressable
        testID="trayCurrentPage"
        accessibilityRole="button"
        accessibilityLabel={`Edit ${title}`}
        accessibilityHint={EDIT_PAGE_HINT}
        onPress={() => setSearchText(initialText)}
        style={({ pressed }) => [panelRowLayout.row, styles.currentPageEdit, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <View style={panelRowLayout.leading}>
          <Favicon iconUrl={faviconUrl} pageUrl={url} size={searchPanel.iconSlot} />
        </View>
        <Text numberOfLines={lines} style={[panelRowLayout.title, styles.currentPageTitle, { color: theme.foregroundPrimary }]}>
          {title}
        </Text>
        <View testID="trayCurrentPageArrow" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.refineArrow}>
          <Symbol name="arrowUpForward" size={searchPanel.trailingGlyph} color={theme.rowIcon} />
        </View>
      </Pressable>
      <Tappable testID="trayCurrentPageCopy" kind="icon" label={actionWords.copyLink} onPress={() => copyLink(url)} style={styles.currentPageCopy}>
        <Symbol name={iconRoles.copyLink} size={searchPanel.trailingGlyph} color={theme.rowIcon} />
      </Tappable>
    </View>
  );
}

type ScrubbedProps = {
  rows: readonly TrayRow[];
  typed: string;
  budget: number;
  onRefine: (row: TrayRow) => void;
  onMenu: (row: TrayRow, at: Point) => void;
  guard: (actions: readonly RowAction[]) => RowAction[];
  onContentHeight: (height: number) => void;
};

function ScrubbedRows({ rows, typed, budget, guard, onRefine, onMenu, onContentHeight }: ScrubbedProps) {
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
  const menus = useMemo(() => rows.map((row) => guard(trayRowActions(row))), [rows, incognito, guard]);

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
    elevation: trayShadow.elevation,
    overflow: "hidden",
  },
  clip: { overflow: "hidden" },
  panelField: { gap: space.s },
  field: {
    borderWidth: stroke.field,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: browseLayout.fieldLeading,
    paddingRight: browseLayout.fieldTrailing,
    ...smoothCorners,
  },
  fieldContents: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center" },
  input: { flex: 1, paddingVertical: 0 },
  leavingText: { textAlignVertical: "center" },
  rows: { flex: 1 },
  stagePanel: { position: "absolute", left: 0, right: 0 },
  incognitoNote: { alignItems: "center", justifyContent: "center", paddingHorizontal: space.l },
  semibold: { fontWeight: "600" },
  centered: { textAlign: "center" },
  rowsContent: { paddingHorizontal: space.s, paddingBottom: space.s },
  searchPanelSheet: { position: "absolute" },
  searchPanelFieldArea: { paddingHorizontal: searchPanel.fieldInset, paddingTop: searchPanel.fieldInset, paddingBottom: searchPanel.rowsTop },
  searchPanelField: {
    borderWidth: searchPanel.fieldEdge,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: searchPanel.fieldLeading,
    paddingRight: searchPanel.fieldTrailing,
    ...smoothCorners,
  },
  searchPanelInput: { flex: 1, paddingVertical: 0 },
  panelIncognitoToggle: { width: "auto", minWidth: slotAround(searchPanel.eyes).width, flexDirection: "row", gap: searchPanel.eyesGap, paddingHorizontal: space.xs },
  panelIncognitoLabel: { fontSize: searchPanel.incognitoLabel, fontWeight: "600" },
  searchPanelWeight: { fontWeight: "500" },
  searchPanelRowsContent: { paddingHorizontal: searchPanel.rowInset, paddingBottom: searchPanel.bottom },
  currentPage: { flexDirection: "row", alignItems: "center" },
  currentPageEdit: { flex: 1 },
  currentPageTitle: { flex: 1 },
  currentPageCopy: slotAround(searchPanel.trailingGlyph),
  refineArrow: { transform: [{ rotate: "-90deg" }] },
  searchPanelCaption: { fontSize: searchPanel.captionSize, fontWeight: "500" },
  highlight: { position: "absolute", borderRadius: radius.row, ...smoothCorners },
});
