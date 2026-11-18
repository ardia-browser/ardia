import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DeckLookProbe } from "./DeckLookProbe";
import { useSheet, useSurface } from "../../state/browse/hooks";
import { useHeldDeckOrder, useHeldRootSize, useHeldSearchOpen } from "../../state/browse/deckHold";
import { beginInteraction, countRender, INTERACTION_WINDOW_MS, interactionPerfEnabled } from "../../state/app/interactionPerf";
import { Keyboard, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, runOnJS, runOnUI, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { pictureKey, whenPicturePainted } from "../../lib/shownSnapshots";
import { countUsage } from "../../state/telemetry/telemetry";
import { haptics } from "../../state/app/haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { labTrace } from "../../platform/lab";
import { measuredOr } from "../../state/app/rootSize";
import {
  DECK,
  deckCardAt,
  deckGeometry,
  archiveCardEdgeY,
  deckScrollActionTarget,
  DECK_CHROME_FROM,
  deckChromeOpacity,
  deckLeading,
  deckIsTap,
  deckDragKind,
  deckLift,
  deckScrollDuringDrag,
  deckScrollAfterChange,
  deckFlyAway,
  deckFlyGoneLift,
  deckFlyPush,
  deckLeaveGoneMs,
  deckLeaveSlotsNow,
  deckSettleTarget,
  deckSettleVelocity,
  deckShouldClose,
  focusedIndex,
  initialDeckScroll,
  openingDeckScroll,
  deckSlotsNow,
  mergeDeckOrder,
  type DeckLeave,
  type DeckLeaving,
  type DeckSlots,
  deckMorphFrom,
  NO_DECK_MORPH,
  type DeckMorph,
} from "../../lib/deckGeometry";
import {
  beginOpeningTab,
  closeAllFromDeck,
  closeTabFromDeck,
  consumeDeckEntrance,
  deckEntranceCapture,
  peekDeckEntrance,
  deckEntered,
  leaveIncognito,
  newIncognitoTab,
  newRegularTab,
  newTab,
  openArchive,
  openSpaces,
  openTab,
  reopenLastClosed,
  unveilOpeningPage,
  whenPageCoverHidden,
  whenPageLaidOut,
} from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useHasArchivedTabs, useIncognito, usePrivateCount, useShownSpace } from "../../state/tabs/hooks";
import { archiveCardLayout, ConfirmDialog, deckChromeLayout, deckChromeMotion, DeckLookBackdrop, iPhoneOr, DeckLookBackdropBase, FrostSource, Menu, moveTo, ScrollActions, Shade, space, tabsCurve, tabsLayout, tabsMotion, type Confirmation, type MenuItem, useDesign, useReduceMotion, usesGlass } from "../ui";
import { openSettings } from "../../state/settings/hooks";
import { confirmInSheet, nativeMenus } from "../ui/MenuTrigger";
import { useSyncEnabled } from "../../state/sync/hooks";
import { isTabPinned, sendTargetsFor, spaceMoveTargets } from "../../state/sync/actions";
import { currentTabs } from "../../state/tabs/store";
import { tabMatchesQuery, type BrowserTab } from "../../state/tabs/tabModels";
import { DeckBar } from "./DeckBar";
import { cardMenuItems as deckCardMenu, cardOpen, DECK_PHASE, DeckCard, leavingZ, OPENING_CARD_MOTION, OPENING_CARD_RESPONSE, OpeningCard, type CardOpen, type DeckMotion } from "./DeckCard";
import { ContainedDeckCard, containedCards, containedDeckScroll } from "./ContainedDeck";
import { MotionView, pageReportsDrawn, type MotionCurve } from "../ui";
import { hideArchiveCard, offerArchiveCard, showArchiveCardNow, useArchiveCardShowing } from "../../state/browse/archiveCard";
import { takeDeckCommand, useDeckCommand } from "../../state/browse/deckCommands";
import { ArchiveCapsule, ArchiveIntervalCard } from "./ArchiveIntervalCard";
import { DeckBottomBar } from "./DeckBottomBar";
import { deckArchiveBottom, DeckHeader, deckHeaderBottom } from "./DeckHeader";
import { DeckEmpty, IncognitoChip } from "./DeckChrome";
import { PageBarGhost } from "../browsing/PageBarGhost";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { TabGrid } from "./TabGrid";
import { tabGridMotion } from "./tabGridLayout";
import { deckGridOffered, useDeckGrid } from "../../state/browse/deckGrid";
import { columnContentLeft, columnContentWidth } from "../../state/app/screenLayout";
import { DeckColumn } from "../column/DeckColumn";
import { ColumnContent, useColumn } from "../column/SideColumn";

type Phase = { kind: "opening" | "settled" | "closing"; id: string | null };

const SETTLED: Phase = { kind: "settled", id: null };

type LeavingCard = { id: string; tab: BrowserTab; at: number };

const NO_LEAVING_CARDS: LeavingCard[] = [];
const NO_LEAVING: DeckLeaving = {};

export function deckShownIds(order: readonly string[], leaving: readonly LeavingCard[]): string[] {
  if (!leaving.length) return order as string[];
  const shown = [...order];
  for (const card of [...leaving].sort((a, b) => a.at - b.at)) shown.splice(Math.min(Math.max(card.at, 0), shown.length), 0, card.id);
  return shown;
}

const deckScrollFor = (ids: readonly string[], target: string | null) => {
  const index = target ? ids.indexOf(target) : -1;
  return index >= 0 ? openingDeckScroll(index, ids.length) : initialDeckScroll(ids.length);
};

const entrancePhase = (ids: readonly string[], target: string | null): Phase => (target && ids.includes(target) ? { kind: "opening", id: target } : SETTLED);

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

export const TabDeck = memo(function TabDeck() {
  countRender("TabDeck");
  const measuresInteractions = interactionPerfEnabled();
  const deckSurface = useSurface();
  const shown = deckSurface === "deck";
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const root = useHeldRootSize();
  const { width, height } = measuredOr(root, window);
  const design = useDesign();
  const redesigned = design === "redesigned";
  const glassChrome = redesigned && usesGlass();
  const gridAvailable = redesigned && deckGridOffered();
  const gridChosen = useDeckGrid();
  const grid = gridAvailable && gridChosen;
  const column = useColumn();
  const deckWidth = column ? columnContentWidth(column, width) : width;
  const contentLeft = column ? columnContentLeft(column) : 0;
  const safeSide = column ? 0 : Math.max(insets.left, insets.right);
  const archiveCard = useArchiveCardShowing();
  const headerGeometry = useMemo(() => deckGeometry(deckWidth, height, insets.top, insets.bottom, safeSide, Platform.OS, design, deckHeaderBottom(), DECK_SCREEN_CORNER()), [deckWidth, height, insets.top, insets.bottom, safeSide, design]);
  const archiveGeometry = useMemo(() => deckGeometry(deckWidth, height, insets.top, insets.bottom, safeSide, Platform.OS, design, deckArchiveBottom(), DECK_SCREEN_CORNER()), [deckWidth, height, insets.top, insets.bottom, safeSide, design]);
  const archiveResizes = redesigned && archiveGeometry.cardWidth < headerGeometry.cardWidth - ARCHIVE_RESIZE_SLACK;
  const g = archiveResizes && archiveCard && !grid ? archiveGeometry : headerGeometry;
  useEffect(() => labTrace(`PAGELAB deck frame ${Math.round(width)}x${Math.round(height)} window ${Math.round(window.width)}x${Math.round(window.height)} insets ${insets.top}/${insets.bottom}`), [width, height, window.width, window.height, insets.top, insets.bottom]);
  const archiveShift = redesigned && !archiveResizes ? archiveGeometry.cardCenterY - headerGeometry.cardCenterY : 0;
  const [deckHeight, setDeckHeight] = useState(height);
  const { tabs: allTabs, selectedId: heldSelected } = useHeldDeckOrder();
  const shownSpace = useShownSpace();
  const [needle, setNeedle] = useState("");
  const live = useMemo(() => (needle ? allTabs.filter((tab) => tabMatchesQuery(tab, needle)) : allTabs), [allTabs, needle]);
  const incognito = useIncognito();
  const privateCount = usePrivateCount();
  const canReopen = useCanReopen();
  const hasArchive = useHasArchivedTabs();
  const syncEnabled = useSyncEnabled();
  const [first] = useState(() => {
    const ids = live.map((t) => t.id);
    const target = shown ? (grid ? null : peekDeckEntrance()) : heldSelected;
    const index = target ? ids.indexOf(target) : -1;
    const phase = entrancePhase(ids, target);
    return {
      ids,
      phase,
      scroll: deckScrollFor(ids, target),
      shownPhase: shown ? phase : SETTLED,
      expanded: shown ? index : -1,
      progress: shown && index < 0 ? 1 : 0,
      cardsOpacity: shown && index >= 0 && !(Boolean(live[index]?.snapshotFileName) || deckEntranceCapture(target!) !== null) ? 1 : 0,
    };
  });
  const [order, setOrder] = useState<string[]>(first.ids);
  const [phase, setPhase] = useState<Phase>(first.phase);
  const [menu, setMenu] = useState<"plus" | "chip" | null>(null);
  const [chromeMenu, setChromeMenu] = useState(false);
  const [cardMenu, setCardMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [leavingCards, setLeavingCards] = useState<LeavingCard[]>(NO_LEAVING_CARDS);
  const leavingIds = useRef(new Set<string>());
  const [anchor, setAnchor] = useState(() => focusedIndex(first.scroll, first.ids.length));
  const [gridLayer, setGridLayer] = useState(grid);
  const [stackLayer, setStackLayer] = useState(!grid);
  const syncedShown = useRef(shown);
  const syncedTabs = useRef(allTabs);
  if (syncedShown.current !== shown || (!shown && syncedTabs.current !== allTabs)) {
    const ids = allTabs.map((t) => t.id);
    const target = shown ? (grid ? null : peekDeckEntrance()) : heldSelected;
    const nextAnchor = focusedIndex(deckScrollFor(ids, target), ids.length);
    const nextPhase = entrancePhase(ids, target);
    if (!sameOrder(order, ids)) setOrder(ids);
    if (nextAnchor !== anchor) setAnchor(nextAnchor);
    if (nextPhase.kind !== phase.kind || nextPhase.id !== phase.id) setPhase(nextPhase);
    if (!shown) {
      if (needle) setNeedle("");
      if (menu) setMenu(null);
      if (chromeMenu) setChromeMenu(false);
      if (cardMenu) setCardMenu(null);
      if (confirmation) setConfirmation(null);
      if (leavingCards.length) setLeavingCards(NO_LEAVING_CARDS);
      if (gridLayer !== grid) setGridLayer(grid);
      if (stackLayer === grid) setStackLayer(!grid);
    }
  }
  useLayoutEffect(() => {
    syncedShown.current = shown;
    syncedTabs.current = allTabs;
  });
  const deckSheet = useSheet();
  const reduceMotion = useReduceMotion();
  const trayOpen = useHeldSearchOpen();
  const probeTouch = useRef<(touching: boolean) => void>(() => undefined);
  const touchChanged = useCallback((on: boolean) => probeTouch.current(on), []);
  const hidden = useRef(new Set<string>());
  const deckPhase = useSharedValue<number>(DECK_PHASE[first.shownPhase.kind]);
  const expandedIndex = useSharedValue(first.expanded);
  const enterPhase = (next: Phase, at: readonly string[] = order) => {
    deckPhase.value = DECK_PHASE[next.kind];
    expandedIndex.value = next.id ? at.indexOf(next.id) : -1;
    setPhase(next);
  };
  const settlePhase = () => {
    "worklet";
    deckPhase.value = DECK_PHASE.settled;
    expandedIndex.value = -1;
  };
  const scroll = useSharedValue(first.scroll);
  const scaleProgress = useSharedValue(first.progress);
  const positionProgress = useSharedValue(first.progress);
  const dragIndex = useSharedValue(-1);
  const dragLift = useSharedValue(0);
  const leaving = useSharedValue<DeckLeaving>(NO_LEAVING);
  const flyClock = useSharedValue(0);
  const covering = useSharedValue("");
  const [openingCard, setOpeningCard] = useState<{ id: string; x: number; y: number; path: CardOpen } | null>(null);
  const orderIds = useSharedValue<readonly string[]>(first.ids);
  const shiftBy = useSharedValue(0);
  const fromSlots = useSharedValue<DeckSlots>({});
  const gap = useSharedValue(1);
  const motion = useMemo<DeckMotion>(
    () => ({ orderIds, shiftBy, fromSlots, gap, phase: deckPhase, expandedIndex, scroll, scaleProgress, positionProgress, dragIndex, dragLift, leaving, flyClock, covering }),
    [orderIds, shiftBy, fromSlots, gap, deckPhase, expandedIndex, scroll, scaleProgress, positionProgress, dragIndex, dragLift, leaving, flyClock, covering],
  );
  const tabs = useMemo(() => new Map(live.map((t) => [t.id, t])), [live]);
  const shownIds = useMemo(() => deckShownIds(order, leavingCards), [order, leavingCards]);
  const contained = containedDeckScroll();
  const DeckCardView = contained ? ContainedDeckCard : DeckCard;
  const backdropStyle = useAnimatedStyle(() => ({ opacity: deckPhase.value === DECK_PHASE.closing ? 1 : Math.min(1, positionProgress.value * BACKDROP_LEAD) }));
  const cardsOpacity = useSharedValue(first.cardsOpacity);
  const cardsShift = useSharedValue(0);
  const handedOverAway = useSharedValue(0);
  const handOverStyle = useAnimatedStyle(() => ({ transform: [{ translateX: handedOverAway.value * HANDED_OVER_AWAY }] }));
  useEffect(() => {
    if (!shown) handedOverAway.value = 0;
  }, [shown]);
  const archiveMorph = useSharedValue<DeckMorph>(NO_DECK_MORPH);
  const archiveMorphed = useSharedValue(1);
  const cardsStyle = useAnimatedStyle(() => {
    if (!redesigned) return { opacity: cardsOpacity.value };
    const morph = archiveMorph.value;
    const left = 1 - archiveMorphed.value;
    return {
      opacity: cardsOpacity.value,
      transformOrigin: [morph.originX, morph.originY, 0],
      transform: [{ translateX: morph.dx * left }, { translateY: cardsShift.value * Math.min(1, Math.max(0, positionProgress.value)) + morph.dy * left }, { scale: 1 + (morph.scale - 1) * left }],
    };
  }, [redesigned]);
  const morphedFrom = useRef(g);
  useEffect(() => {
    const was = morphedFrom.current;
    morphedFrom.current = g;
    if (was === g) return;
    const archiveSwap = (was === headerGeometry || was === archiveGeometry) && was.width === g.width && was.height === g.height;
    if (!archiveSwap || reduceMotion || !shown || positionProgress.value < 1) {
      archiveMorphed.value = 1;
      return;
    }
    archiveMorph.value = deckMorphFrom(was, g);
    archiveMorphed.value = 0;
    archiveMorphed.value = withSpring(1, tabsMotion.expand);
  }, [g]);
  useEffect(() => {
    if (!redesigned) return;
    const target = archiveCard ? archiveShift : 0;
    cardsShift.value = reduceMotion ? withTiming(target, { duration: tabsMotion.fade }) : withSpring(target, deckChromeMotion.chromeShift);
  }, [archiveCard, archiveShift, redesigned]);
  const chromeOpacity = useDerivedValue(() => deckChromeOpacity(positionProgress.value));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chromeOpacity.value }));
  const chipStyle = useAnimatedStyle(() => ({ opacity: dragIndex.value >= 0 ? 0 : deckChromeOpacity(positionProgress.value) }));

  const searchedFor = useRef(needle);
  const spaceShown = useRef(shownSpace);
  const openingId = useRef<string | null>(null);
  const handedOver = useRef<string | null>(null);
  const openPath = useRef<CardOpen>("deckCard");
  const stopDrawnWait = useRef<() => void>(() => undefined);
  const coverPending = useRef<string | null>(null);
  const landingCap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const landing = useSharedValue(false);
  const touching = useSharedValue(false);

  const placeCards = (ids: readonly string[], at: number) =>
    runOnUI((next: readonly string[], to: number) => {
      "worklet";
      fromSlots.value = {};
      shiftBy.value = 0;
      gap.value = 1;
      leaving.value = {};
      cancelAnimation(flyClock);
      dragIndex.value = -1;
      dragLift.value = 0;
      orderIds.value = next;
      scroll.value = to;
    })(ids, at);

  useLayoutEffect(() => {
    if (shown) return;
    hidden.current.clear();
    leavingIds.current.clear();
    openingId.current = null;
    landing.value = false;
    covering.value = "";
    prepared.current = null;
    coverPending.current = null;
    clearTimeout(landingCap.current);
    stopDrawnWait.current();
    setOpeningCard(null);
    placeCards(order, deckScrollFor(order, heldSelected));
    deckPhase.value = DECK_PHASE.settled;
    expandedIndex.value = -1;
    scaleProgress.value = 0;
    positionProgress.value = 0;
    cardsOpacity.value = 0;
    touching.value = false;
  }, [shown, order, heldSelected]);

  useLayoutEffect(() => {
    if (!shown) return;
    spaceShown.current = shownSpace;
    searchedFor.current = needle;
    const entrance = peekDeckEntrance();
    const index = entrance ? order.indexOf(entrance) : -1;
    placeCards(order, index >= 0 ? openingDeckScroll(index, order.length) : initialDeckScroll(order.length));
    if (!entrance || index < 0 || grid) {
      deckPhase.value = DECK_PHASE.settled;
      expandedIndex.value = -1;
      scaleProgress.value = 1;
      positionProgress.value = 1;
      cardsOpacity.value = withTiming(1, { duration: tabsMotion.fade });
      if (entrance && grid) deckEntered(entrance);
      return;
    }
    beginInteraction("deck open", INTERACTION_WINDOW_MS.deckOpen);
    deckPhase.value = DECK_PHASE.opening;
    expandedIndex.value = index;
    scaleProgress.value = 0;
    positionProgress.value = 0;
    const shrink = () => {
      cardsOpacity.value = 1;
      scaleProgress.value = moveTo(1, tabsMotion.openScale);
      positionProgress.value = moveTo(1, tabsMotion.openPosition, (finished) => {
        "worklet";
        if (!finished) return;
        settlePhase();
        runOnJS(setPhase)(SETTLED);
        runOnJS(deckEntered)(entrance);
      });
    };
    const capture = deckEntranceCapture(entrance);
    if (!capture && !tabs.get(entrance)?.snapshotFileName) {
      shrink();
      return () => deckEntered(entrance);
    }
    cardsOpacity.value = 0;
    let frame = 0;
    let live = true;
    let waited = false;
    let stopWaiting = () => {};
    const waitForPaint = () => {
      if (!live || waited) return;
      waited = true;
      const now = currentTabs();
      const picture = [...now.open, ...now.privates].find((tab) => tab.id === entrance)?.snapshotFileName;
      if (!picture) {
        frame = requestAnimationFrame(shrink);
        return;
      }
      stopWaiting = whenPicturePainted(pictureKey(`deck:${entrance}`, picture), ENTRANCE_PAINT_CAP_MS, (painted) => {
        if (!painted && !tabs.get(entrance)?.isPrivate) countUsage("deck_pictures_late");
        frame = requestAnimationFrame(shrink);
      });
    };
    if (capture) {
      const cap = setTimeout(waitForPaint, ENTRANCE_CAPTURE_CAP_MS);
      void capture.then(() => {
        clearTimeout(cap);
        waitForPaint();
      });
      stopWaiting = () => clearTimeout(cap);
    } else waitForPaint();
    return () => {
      live = false;
      stopWaiting();
      cancelAnimationFrame(frame);
      deckEntered(entrance);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    consumeDeckEntrance();
    offerArchiveCard(order.length);
    return () => void hideArchiveCard();
  }, [shown]);

  const shiftDeck = (ids: readonly string[], target: number, shift: number, expanded: number, keeps: boolean, faded: boolean, joining: { id: string; spec: DeckLeave } | null) => {
      "worklet";
      const was = leaving.value;
      const carried = deckLeaveSlotsNow(was, fromSlots.value, shiftBy.value, gap.value);
      const slots: Record<string, number> = { ...deckSlotsNow(orderIds.value, fromSlots.value, shiftBy.value, gap.value), ...carried };
      const still: Record<string, DeckLeave> = {};
      for (const id of Object.keys(was)) still[id] = { ...was[id]!, at: carried[id]! + shift };
      if (joining) {
        if (Object.keys(was).length === 0) {
          flyClock.value = 0;
          flyClock.value = withTiming(FLY_CLOCK_SPAN_MS, { duration: FLY_CLOCK_SPAN_MS, easing: Easing.linear });
        }
        still[joining.id] = { ...joining.spec, t0: flyClock.value };
        dragIndex.value = -1;
        dragLift.value = 0;
      }
      fromSlots.value = slots;
      leaving.value = still;
      shiftBy.value = shift;
      if (keeps) expandedIndex.value = expanded;
      orderIds.value = ids;
      scroll.value = target;
      gap.value = 0;
      gap.value = faded ? withTiming(1, { duration: tabsMotion.fade }) : withSpring(1, tabsMotion.gapClose);
  };
  const moveCards = (next: readonly string[], to: number, by: number, expandedAt: number, keepsExpanded: boolean, reduced: boolean, leave: { id: string; spec: DeckLeave } | null) =>
    runOnUI(shiftDeck)(next, to, by, expandedAt, keepsExpanded, reduced, leave);

  useEffect(() => {
    if (!shown) return;
    const ids = live.flatMap((t) => (leavingIds.current.has(t.id) ? [] : [t.id]));
    const alive = new Set(allTabs.map((t) => t.id));
    if (spaceShown.current !== shownSpace) {
      spaceShown.current = shownSpace;
      searchedFor.current = needle;
      showNewSpace(ids, alive);
      return;
    }
    const next = mergeDeckOrder(order, ids);
    const searched = searchedFor.current !== needle;
    searchedFor.current = needle;
    if (!searched && next.length === order.length && next.every((id, i) => id === order[i])) return;
    const before = scroll.value;
    const after = deckScrollAfterChange(order, next, before, searched);
    for (const id of hidden.current) if (!alive.has(id)) hidden.current.delete(id);
    const expanded = phase.id ? next.indexOf(phase.id) : -1;
    moveCards(next, after, after - before, expanded, phase.id !== null && coverPending.current !== phase.id, reduceMotion, null);
    setAnchor(Math.round(after));
    setOrder(next);
  }, [live]);

  const showNewSpace = (ids: string[], alive: ReadonlySet<string>) => {
    const to = initialDeckScroll(ids.length);
    for (const id of hidden.current) if (!alive.has(id)) hidden.current.delete(id);
    runOnUI((next: readonly string[], at: number) => {
      "worklet";
      fromSlots.value = {};
      shiftBy.value = 0;
      leaving.value = {};
      cancelAnimation(flyClock);
      dragIndex.value = -1;
      dragLift.value = 0;
      orderIds.value = next;
      scroll.value = at;
      gap.value = 1;
    })(ids, to);
    leavingIds.current.clear();
    setLeavingCards(NO_LEAVING_CARDS);
    cardsOpacity.value = 0;
    cardsOpacity.value = withTiming(1, { duration: tabsMotion.fade });
    setAnchor(to);
    setOrder(ids);
    if (!archiveCard) offerArchiveCard(ids.length);
  };

  const settledOpen = (id: string) => openTab(id);

  const command = useDeckCommand((s) => s.command);
  useEffect(() => {
    if (!command || !shown || phase.kind !== "settled") return;
    takeDeckCommand(command.id);
    const focused = focusedIndex(scroll.value, order.length);
    if (command.kind === "scroll") {
      const target = Math.min(Math.max(command.index, 0), Math.max(order.length - 1, 0));
      setAnchor(target);
      scroll.value = withSpring(target, tabsMotion.settle);
    }
    else if (command.kind === "closeFocused") close(focused, 0);
    else if (command.kind === "openFocused") open(focused);
    else if (command.kind === "openSelected") {
      const selected = currentTabs().selectedId;
      const at = selected ? order.indexOf(selected) : -1;
      open(at >= 0 ? at : focused);
    }
    else if (command.kind === "lift") {
      if (grid) return;
      dragIndex.value = focused;
      dragLift.value = command.offset;
    } else showArchiveCardNow();
  }, [command, phase.kind, shown]);

  useEffect(() => () => void (openingId.current = null), []);
  const open = (index: number) => {
    beginInteraction("card open", INTERACTION_WINDOW_MS.cardOpen);
    const id = order[index];
    if (!id || phase.kind !== "settled" || dragIndex.value === index) return;
    if (redesigned) Keyboard.dismiss();
    if (reduceMotion || grid) {
      settledOpen(id);
      return;
    }
    setMenu(null);
    const path = cardOpen();
    openPath.current = path;
    if (path === "coveringCard") {
      coverPending.current = id;
      deckPhase.value = DECK_PHASE.closing;
      setPhase({ kind: "closing", id });
    } else enterPhase({ kind: "closing", id });
    openingId.current = id;
    handedOver.current = null;
    prepared.current = null;
    if (path !== "deckCard") setOpeningCard({ id, x: deckLeading(g, index - scroll.value) + g.cardWidth / 2, y: g.cardCenterY + (redesigned ? cardsShift.value : 0), path });
    if (path === "coveringCard") return;
    requestAnimationFrame(() => {
      if (openingId.current !== id) return;
      landing.value = true;
      scaleProgress.value = withSpring(0, tabsMotion.expand);
      positionProgress.value = withSpring(0, tabsMotion.expand, (finished) => {
        if (finished) runOnJS(handOver)(id);
      });
    });
  };

  const handOverLanded = () => {
    if (openingId.current) handOver(openingId.current);
  };

  useAnimatedReaction(
    () => landing.value && Math.abs(scaleProgress.value) < CARD_LANDED && Math.abs(positionProgress.value) < CARD_LANDED,
    (landed, was) => {
      if (!landed || was) return;
      landing.value = false;
      scaleProgress.value = 0;
      positionProgress.value = 0;
      runOnJS(handOverLanded)();
    },
  );

  const prepared = useRef<{ id: string; ready: boolean; landed: boolean } | null>(null);
  const finishOpen = (id: string) => {
    if (openPath.current !== "deckCard") {
      if (openingId.current !== id) return;
      if (openPath.current === "coveringCard") handedOverAway.value = 1;
      settledOpen(id);
      return;
    }
    requestAnimationFrame(() => {
      if (openingId.current === id) settledOpen(id);
    });
  };
  const prepareHandOver = (id: string, veiled = false) => {
    if (openingId.current !== id || prepared.current?.id === id) return;
    const state = { id, ready: false, landed: false };
    prepared.current = state;
    beginOpeningTab(id, veiled);
    const picture = tabs.get(id)?.snapshotFileName ?? null;
    let waiting = picture ? 2 : 1;
    const ready = () => {
      waiting -= 1;
      if (waiting > 0 || prepared.current !== state) return;
      state.ready = true;
      if (state.landed) finishOpen(id);
    };
    whenPageLaidOut(id, HANDOVER_CAP_MS, ready);
    if (picture) whenPicturePainted(pictureKey(`cover:${id}`, picture), HANDOVER_CAP_MS, ready);
  };
  const coverDeck = (id: string) => {
    if (openingId.current !== id) return;
    coverPending.current = null;
    runOnUI((covered: string, expanded: number) => {
      "worklet";
      covering.value = covered;
      expandedIndex.value = expanded;
    })(id, order.indexOf(id));
    requestAnimationFrame(() => {
      if (openingId.current !== id) return;
      runOnUI(() => {
        "worklet";
        scaleProgress.value = 0;
        positionProgress.value = withSpring(0, tabsMotion.expand);
      })();
      prepareHandOver(id, true);
    });
    clearTimeout(landingCap.current);
    landingCap.current = setTimeout(() => landCoveringCard(id), COVERING_LANDING_CAP_MS);
  };
  const landCoveringCard = (id: string) => {
    if (openingId.current !== id || handedOver.current === id) return;
    clearTimeout(landingCap.current);
    positionProgress.value = 0;
    prepareHandOver(id);
    unveilOpeningPage(id);
    if (!pageReportsDrawn()) {
      handOver(id);
      return;
    }
    handedOver.current = id;
    stopDrawnWait.current = whenPageCoverHidden(id, COVER_LOST_MS, (reason) => {
      if (reason !== "drawn" && !tabs.get(id)?.isPrivate) countUsage("card_opens_waited");
      finishOpen(id);
    });
  };
  const openingCardGrowing = (id: string) => {
    if (openPath.current === "coveringCard") {
      coverDeck(id);
      return;
    }
    covering.value = id;
    setTimeout(() => prepareHandOver(id), PAGE_MOUNT_AFTER_GROWTH_MS);
    setTimeout(() => handOver(id), criticalSpringLandsMs(OPENING_CARD_RESPONSE, CARD_LANDED));
  };

  const handOver = (id: string) => {
    if (openingId.current !== id || handedOver.current === id) return;
    handedOver.current = id;
    prepareHandOver(id);
    const state = prepared.current;
    if (!state || state.id !== id) return;
    state.landed = true;
    if (state.ready) finishOpen(id);
    else if (!tabs.get(id)?.isPrivate) countUsage("card_opens_waited");
  };

  const remove = (id: string) => {
    hidden.current.add(id);
    closeTabFromDeck(id);
  };

  const finishLeaving = (id: string, closesDeck: boolean) => {
    leavingIds.current.delete(id);
    setLeavingCards((now) => now.filter((card) => card.id !== id));
    runOnUI((gone: string) => {
      "worklet";
      const { [gone]: _left, ...rest } = leaving.value;
      leaving.value = rest;
      if (Object.keys(rest).length === 0) cancelAnimation(flyClock);
    })(id);
    if (closesDeck) closeTabFromDeck(id);
  };

  const close = (index: number, startLift: number, velocity = 0) => {
    const id = order[index];
    const tab = id ? tabs.get(id) : undefined;
    if (!id || !tab || leavingIds.current.has(id)) return;
    hideArchiveCard();
    if (grid) {
      remove(id);
      return;
    }
    const next = order.filter((other) => other !== id);
    const before = scroll.value;
    const after = deckScrollAfterChange(order, next, before, false);
    const spec = flySpec(index, order.length, startLift, velocity);
    moveCards(next, after, after - before, -1, false, reduceMotion, { id, spec });
    flownOff(id, index, spec, next, after);
  };

  const flySpec = (index: number, count: number, startLift: number, velocity: number): DeckLeave => {
    "worklet";
    const away = deckFlyAway(g, redesigned ? cardsShift.value : 0);
    return { at: index, z: leavingZ(index), t0: 0, lift: startLift, away, push: deckFlyPush(velocity, startLift, away), response: tabsMotion.cardFlyAway, fadeMs: reduceMotion ? tabsMotion.fade : 0, last: index === count - 1 };
  };

  const flownOff = (id: string, index: number, spec: DeckLeave, next: readonly string[], after: number) => {
    const tab = tabs.get(id);
    if (leavingIds.current.has(id)) return;
    if (!tab) {
      finishLeaving(id, false);
      return;
    }
    const closesDeck = allTabs.filter((other) => other.id !== id).length === 0;
    leavingIds.current.add(id);
    setLeavingCards((now) => [...now, { id, tab, at: index }]);
    setAnchor(Math.round(after));
    setOrder([...next]);
    if (!closesDeck) closeTabFromDeck(id);
    setTimeout(() => finishLeaving(id, closesDeck), deckLeaveGoneMs(spec, deckFlyGoneLift(spec, g.cardHeight)) + LEAVE_SLACK_MS);
  };

  const count = order.length;
  useAnimatedReaction(
    () => (touching.value ? focusedIndex(scroll.value, count) : -1),
    (focused, previous) => {
      if (focused >= 0 && previous !== null && previous >= 0 && focused !== previous) runOnJS(focusTick)();
    },
    [count],
  );
  const startScroll = useSharedValue(0);
  const vertical = useSharedValue(false);
  const touchDown = useSharedValue({ x: 0, y: 0, absoluteX: 0, absoluteY: 0 });
  const scrollFrom = useSharedValue(0);
  const barBand = { bottom: g.barCenterY - tabsLayout.barTouchClearance - g.height };
  const pan = Gesture.Pan()
    .withTestId("deckPan")
    .hitSlop(barBand)
    .minDistance(10)
    .onBegin((e) => {
      touchDown.value = { x: e.x, y: e.y, absoluteX: e.absoluteX, absoluteY: e.absoluteY };
    })

    .onStart((e) => {
      const down = touchDown.value;
      const card = deckCardAt(g, count, scroll.value, down.x, down.y);
      if (measuresInteractions) runOnJS(beginInteraction)("deck scroll", INTERACTION_WINDOW_MS.deckScroll);
      startScroll.value = scroll.value;
      scrollFrom.value = e.absoluteX;
      touching.value = true;
      runOnJS(touchChanged)(true);
      runOnJS(hideArchiveCard)();
      if (deckDragKind(card, e.absoluteX - down.absoluteX, e.absoluteY - down.absoluteY) === "lift") {
        vertical.value = true;
        dragIndex.value = card;
        dragLift.value = deckLift(e.absoluteY - down.absoluteY);
        return;
      }
      vertical.value = false;
    })
    .onUpdate((e) => {
      const down = touchDown.value;
      if (vertical.value) {
        dragLift.value = deckLift(e.absoluteY - down.absoluteY);
        return;
      }
      scroll.value = deckScrollDuringDrag(g, startScroll.value, e.absoluteX - scrollFrom.value, count);
    })
    .onEnd((e) => {
      if (vertical.value) {
        touching.value = false;
        const card = dragIndex.value;
        if (deckShouldClose(e.absoluteY - touchDown.value.absoluteY, e.velocityY, g.cardHeight)) {
          runOnJS(flickTick)();
          const ids = orderIds.value;
          const id = ids[card];
          if (id !== undefined && !(id in leaving.value)) {
            const spec = flySpec(card, ids.length, dragLift.value, e.velocityY);
            const next = ids.filter((other) => other !== id);
            const before = scroll.value;
            const after = deckScrollAfterChange(ids, next, before, false);
            shiftDeck(next, after, after - before, -1, false, reduceMotion, { id, spec });
            runOnJS(flownOff)(id, card, spec, next, after);
          }
          runOnJS(touchChanged)(false);
        } else {
          dragLift.value = withSpring(0, tabsMotion.release, (finished) => {
            if (finished) dragIndex.value = -1;
            runOnJS(touchChanged)(false);
          });
        }
        return;
      }
      const target = deckSettleTarget(g, scroll.value, e.velocityX, count);
      const settled = () => {
        "worklet";
        touching.value = false;
        runOnJS(setAnchor)(target);
        runOnJS(touchChanged)(false);
      };
      scroll.value = reduceMotion
        ? withTiming(target, { duration: tabsMotion.fade, easing: tabsCurve.easeOut }, settled)
        : withSpring(target, { ...tabsMotion.settle, velocity: deckSettleVelocity(g, scroll.value, target, e.velocityX) }, settled);
    });
  const showCardMenu = (index: number, x: number, y: number) => {
    if (phase.kind !== "settled" || !order[index]) return;
    menuOpenedHaptic();
    hideArchiveCard();
    setMenu(null);
    setCardMenu({ index, x, y });
  };
  const longPress = Gesture.LongPress()
    .withTestId("deckLongPress")
    .enabled(!nativeMenus())
    .hitSlop(barBand)
    .minDuration(tabsMotion.longPress)
    .onStart((e) => {
      const card = deckCardAt(g, count, scroll.value, e.x, e.y);
      if (card >= 0) runOnJS(showCardMenu)(card, e.x, e.y);
    });
  const tapFrom = useSharedValue({ x: 0, y: 0 });
  const tap = Gesture.Manual()
    .hitSlop(barBand)
    .onTouchesDown((e) => {
      const touch = e.allTouches[0];
      if (touch) tapFrom.value = { x: touch.x, y: touch.y };
    })
    .onTouchesUp((e, manager) => {
      const touch = e.changedTouches[0];
      if (touch && deckIsTap(touch.x - tapFrom.value.x, touch.y - tapFrom.value.y)) {
        const card = deckCardAt(g, count, scroll.value, touch.x, touch.y);
        if (card >= 0) runOnJS(open)(card);
        else if (redesigned) runOnJS(dismissKeyboard)();
      }
      manager.fail();
    });

  const cardMenuItems = (index: number): MenuItem[] => {
    const tab = tabs.get(order[index] ?? "");
    const closeCard = () => close(index, 0);
    if (!tab) return [{ label: "Close Tab", destructive: true, onPress: closeCard }];
    return deckCardMenu(tab, { devices: sendTargetsFor(tab), pinned: isTabPinned(tab), syncEnabled, spaces: redesigned ? spaceMoveTargets(tab) : [] }, closeCard);
  };

  const ask = (confirmation: Confirmation) => confirmInSheet(confirmation, () => setConfirmation(confirmation));
  const confirmCloseAll = () =>
    ask({
      title: count === 1 ? "Close 1 Tab?" : `Close ${count} Tabs?`,
      message: privateCount ? "Incognito tabs aren’t saved. Other tabs stay in your Archive." : "They’ll stay in your Archive.",
      action: count === 1 ? "Close Tab" : "Close All Tabs",
      run: () => {
        hideArchiveCard();
        haptics.press();
        closeAllFromDeck();
      },
    });
  const confirmLeaveIncognito = () =>
    ask({
      title: "Close Incognito Tabs?",
      message: "Their pages, cookies and history are cleared.",
      action: "Close Incognito Tabs",
      run: () => {
        haptics.press();
        leaveIncognito();
      },
    });

  const closeNow = (at: number) => {
    const closing = order[at];
    if (closing) remove(closing);
  };
  const latestActions = useRef({ open, close, closeNow, order });
  latestActions.current = { open, close, closeNow, order };
  const cardActions = useMemo(
    () => ({
      open: (at: number) => latestActions.current.open(at),
      close: (at: number) => latestActions.current.close(at, 0),
      closeNow: (at: number) => latestActions.current.closeNow(at),
      openTab: (id: string) => {
        const at = latestActions.current.order.indexOf(id);
        if (at >= 0) latestActions.current.open(at);
      },
      closeTab: (id: string) => {
        const at = latestActions.current.order.indexOf(id);
        if (at >= 0) latestActions.current.closeNow(at);
      },
    }),
    [],
  );
  const crossfade = reduceMotion ? tabGridMotion.crossfadeReduced : tabGridMotion.crossfade;
  const gridTabs = gridAvailable && (grid || gridLayer) ? order.flatMap((id) => {
    const tab = tabs.get(id);
    return tab && !hidden.current.has(id) ? [tab] : [];
  }) : [];
  const plusItems: MenuItem[] = incognito
    ? [
        { label: "New Tab", icon: "plus", onPress: newRegularTab },
        { label: "New Incognito Tab", icon: "eyes", onPress: newTab },
      ]
    : [
        { label: "New Incognito Tab", icon: "eyes", onPress: newIncognitoTab },
        ...(canReopen ? [{ label: "Reopen Closed Tab", icon: "arrowUturnBackward" as const, onPress: reopenLastClosed }] : []),
      ];
  if (count)
    plusItems.push("divider", {
      label: incognito ? "Close Incognito Tabs" : "Close All Tabs",
      icon: "xmark",
      destructive: true,
      onPress: incognito ? confirmLeaveIncognito : confirmCloseAll,
    });

  return (
    <Animated.View
      testID="tabDeck"
      style={[StyleSheet.absoluteFill, shown ? null : styles.hidden, handOverStyle]}
      pointerEvents={shown ? "auto" : "none"} collapsable={false}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      accessibilityElementsHidden={!shown}
      onLayout={(event) => {
        const laidOut = event.nativeEvent.layout.height;
        if (laidOut > 0) setDeckHeight(laidOut);
      }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]} pointerEvents="none">
        <DeckLookBackdropBase />
        <FrostSource name={DECK_FROST} style={StyleSheet.absoluteFill} pointerEvents="none">
          <DeckLookBackdrop baseOutside />
        </FrostSource>
      </Animated.View>
      <Shade shaded={menu !== null || (chromeMenu && !nativeMenus()) || cardMenu !== null || confirmation !== null}>
        <ColumnContent column={column} width={width} clips>
        <StackLayer available={gridAvailable} grid={grid} motion={crossfade} onFaded={() => setStackLayer(!grid)}>
        <ScrollActions
          style={StyleSheet.absoluteFill}
          pointerEvents="box-none"
          canScrollForward={deckScrollActionTarget(anchor, count, "forward") !== null}
          canScrollBackward={deckScrollActionTarget(anchor, count, "backward") !== null}
          onScrollAction={(direction) => {
            const target = deckScrollActionTarget(anchor, count, direction);
            if (target === null) return;
            setAnchor(target);
            scroll.value = reduceMotion ? withTiming(target, { duration: tabsMotion.fade }) : withSpring(target, tabsMotion.settle);
          }}
        >
          <GestureDetector gesture={shown ? Gesture.Race(pan, longPress, tap) : Gesture.Race(Gesture.Manual().enabled(false).onTouchesDown(ignoreTouch))}>
            <Animated.View testID="deckCards" style={[styles.touch, { height: g.height }, cardsStyle]} collapsable={false}>
              {containedCards(contained, { ids: shownIds, geometry: g, motion }, shownIds.map((id) => {
                const flying = leavingCards.find((card) => card.id === id);
                const tab = flying?.tab ?? tabs.get(id);
                const index = flying ? -1 : order.indexOf(id);
                if (!tab || (!flying && hidden.current.has(id)) || !deckCardMounted(flying ? flying.at : index, anchor) || (grid && !stackLayer)) return null;
                return (
                  <DeckCardView
                    key={id}
                    tab={tab}
                    index={index}
                    geometry={g}
                    motion={motion}
                    onOpen={cardActions.open}
                    onClose={cardActions.close}
                    onCloseNow={cardActions.closeNow}
                  />
                );
              }))}
            </Animated.View>
          </GestureDetector>
        </ScrollActions>
        </StackLayer>
        {gridAvailable && shown && (grid || gridLayer) ? (
          <MotionView
            testID="tabGridLayer"
            style={StyleSheet.absoluteFill}
            pointerEvents={grid ? "box-none" : "none"}
            collapsable={false}
            accessibilityElementsHidden={!grid}
            importantForAccessibility={grid ? "auto" : "no-hide-descendants"}
            from={gridLayer ? undefined : HIDDEN}
            to={grid ? SHOWN : HIDDEN}
            motion={crossfade}
            onMotionEnd={(finished) => {
              if (finished) setGridLayer(grid);
            }}
          >
            <TabGrid tabs={gridTabs} selectedId={heldSelected} geometry={g} reduceMotion={reduceMotion} onOpen={cardActions.openTab} onClose={cardActions.closeTab} />
          </MotionView>
        ) : null}
        {!count && !leavingCards.length && phase.kind === "settled" ? <DeckEmpty centerY={g.cardCenterY} showsArchive={hasArchive} onArchive={openArchive} searching={needle !== ""} /> : null}
        {archiveCard && phase.kind === "settled" && !grid ? (
          redesigned ? (
            <ArchiveCapsule centerY={g.safeTop + deckChromeLayout.archiveCenter} safeSide={g.safeSide} />
          ) : (
            <ArchiveIntervalCard edgeY={archiveCardEdgeY(g, archiveCardLayout.aboveBarCenter)} />
          )
        ) : null}
        {openingCard && tabs.get(openingCard.id) ? <OpeningCard key={openingCard.id} tab={tabs.get(openingCard.id)!} geometry={g} centerX={openingCard.x} centerY={openingCard.y} growsAtMount={openingCard.path === "coveringCard"} endsSquare={openingCard.path === "coveringCard"} onGrowing={() => openingCardGrowing(openingCard.id)} onLanded={openingCard.path === "coveringCard" ? () => landCoveringCard(openingCard.id) : undefined} /> : null}
        </ColumnContent>
        {Platform.OS === "android" && !redesigned && !column && phase.id && (phase.kind === "opening" || (phase.kind === "closing" && openPath.current === "deckCard")) && tabs.get(phase.id) ? <PageBarGhost tab={tabs.get(phase.id)!} positionProgress={positionProgress} /> : null}
        <MotionView testID="deckChromeFade" style={StyleSheet.absoluteFill} pointerEvents="box-none" to={{ opacity: openingCard ? 0 : 1 }} motion={openingCard ? OPENING_CARD_MOTION : CHROME_BACK}>
        {redesigned ? (
          <Animated.View testID="deckRedesignedChrome" style={glassChrome ? StyleSheet.absoluteFill : [StyleSheet.absoluteFill, chromeStyle]} pointerEvents={phase.kind === "settled" ? "box-none" : "none"} collapsable={false} importantForAccessibility={phase.kind === "settled" ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={phase.kind !== "settled"}>
            <ChromeGlassShown progress={positionProgress} initiallyIn={first.progress >= DECK_CHROME_FROM} away={!shown || phase.kind === "closing" || openingCard !== null}>
              {(glassShown) => (
                <>
                  <ColumnContent column={column} width={width}>
                  <DeckHeader
                    safeTop={g.safeTop}
                    safeSide={g.safeSide}
                    privateCount={privateCount}
                    hasTabs={allTabs.length > 0}
                    menusShown={shown && phase.kind === "settled"}
                    showsMore={!column}
                    onMenu={setChromeMenu}
                    onCloseIncognito={confirmLeaveIncognito}
                    onCloseAll={confirmCloseAll}
                    glassShown={glassShown}
                    glassShownMs={CHROME_GLASS_MS}
                    glyphFade={glassChrome ? chromeOpacity : undefined}
                  />
                  </ColumnContent>
                  {column ? (
                    <DeckColumn
                      column={column}
                      width={width}
                      shown={shown}
                      incognito={incognito}
                      hasTabs={allTabs.length > 0}
                      onQuery={setNeedle}
                      onCloseAll={confirmCloseAll}
                      menusShown={shown && phase.kind === "settled"}
                      onMenu={setChromeMenu}
                      glassShown={glassShown}
                      glassShownMs={CHROME_GLASS_MS}
                      glyphFade={glassChrome ? chromeOpacity : undefined}
                    />
                  ) : (
                  <DeckBottomBar
                    shown={shown}
                    barCenterY={g.barCenterY}
                    deckHeight={deckHeight}
                    safeSide={g.safeSide}
                    incognito={incognito}
                    onQuery={setNeedle}
                    menusShown={shown && phase.kind === "settled"}
                    onMenu={setChromeMenu}
                    glassShown={glassShown}
                    glassShownMs={CHROME_GLASS_MS}
                    glyphFade={glassChrome ? chromeOpacity : undefined}
                  />
                  )}
                </>
              )}
            </ChromeGlassShown>
          </Animated.View>
        ) : privateCount > 0 ? (
          <Animated.View style={[StyleSheet.absoluteFill, chipStyle]} pointerEvents={phase.kind === "settled" ? "box-none" : "none"} collapsable={false} importantForAccessibility={phase.kind === "settled" ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={phase.kind !== "settled"}>
            <IncognitoChip count={privateCount} top={g.safeTop} onPress={() => setMenu("chip")} />
          </Animated.View>
        ) : null}
        {redesigned ? null : (
          <Animated.View
            pointerEvents={phase.kind === "settled" ? "box-none" : "none"} collapsable={false} importantForAccessibility={phase.kind === "settled" ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={phase.kind !== "settled"}
            style={[styles.bar, { top: g.barCenterY - tabsLayout.barPlus.height / 2 - 2, paddingHorizontal: g.safeSide + tabsLayout.barSideInset - 4 }, chromeStyle]}
          >
            <DeckBar
              leading={
                syncEnabled ? { icon: "laptop", label: "Synced Tabs", onPress: openSpaces } : { icon: "archivebox", label: "Archive", onPress: openArchive }
              }
              plusLabel={incognito ? "New Incognito Tab" : "New Tab"}
              frost={{ source: DECK_FROST, variant: "bar" }}
              covered={trayOpen}
              onPlus={newTab}
              onPlusMenu={() => setMenu("plus")}
              onSettings={() => openSettings()}
            />
          </Animated.View>
        )}
        </MotionView>
      </Shade>
      <DeckLookProbe
        busy={phase.kind !== "settled" || menu !== null || chromeMenu || cardMenu !== null || confirmation !== null || deckSheet !== null || trayOpen || deckSurface !== "deck" || archiveCard}
        touch={probeTouch}
      />
      {menu === "plus" && !redesigned ? (
        <Menu
          items={plusItems}
          place={{ bottom: deckHeight - g.barCenterY + tabsLayout.barPlus.height, left: (width - tabsLayout.menuWidth) / 2, width: tabsLayout.menuWidth }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {menu === "chip" ? (
        <Menu
          items={[{ label: "Close Incognito Tabs", icon: "xmark", destructive: true, onPress: confirmLeaveIncognito }]}
          place={{ top: g.safeTop + tabsLayout.chipHeight + tabsLayout.headerGap * 2, left: (width - tabsLayout.menuWidth) / 2, width: tabsLayout.menuWidth }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {cardMenu ? (
        <Menu
          items={cardMenuItems(cardMenu.index)}
          place={{
            top: Math.min(cardMenu.y, height - tabsLayout.cardMenuHeight),
            left: contentLeft + Math.min(Math.max(cardMenu.x - tabsLayout.menuWidth / 2, space.l), deckWidth - tabsLayout.menuWidth - space.l),
            width: tabsLayout.menuWidth,
          }}
          onDismiss={() => setCardMenu(null)}
        />
      ) : null}
      {confirmation ? <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </Animated.View>
  );
});

function StackLayer({ available, grid, motion, onFaded, children }: { available: boolean; grid: boolean; motion: MotionCurve; onFaded: () => void; children: ReactNode }) {
  if (!available) return children;
  return (
    <MotionView
      testID="deckStackLayer"
      style={StyleSheet.absoluteFill}
      pointerEvents={grid ? "none" : "box-none"}
      collapsable={false}
      accessibilityElementsHidden={grid}
      importantForAccessibility={grid ? "no-hide-descendants" : "auto"}
      to={grid ? HIDDEN : SHOWN}
      motion={motion}
      onMotionEnd={(finished) => {
        if (finished) onFaded();
      }}
    >
      {children}
    </MotionView>
  );
}

function ChromeGlassShown({ progress, initiallyIn, away, children }: { progress: SharedValue<number>; initiallyIn: boolean; away: boolean; children: (glassShown: boolean) => ReactNode }) {
  const [entered, setEntered] = useState(initiallyIn);
  useAnimatedReaction(
    () => progress.value >= DECK_CHROME_FROM,
    (now, was) => {
      if (now !== was) runOnJS(setEntered)(now);
    },
  );
  return children(entered && !away);
}

const ignoreTouch = () => {
  "worklet";
};

const focusTick = () => haptics.tick();
const dismissKeyboard = () => Keyboard.dismiss();
const flickTick = () => haptics.tap();

const DECK_FROST = "deck";
const SHOWN = { opacity: 1 };
const HIDDEN = { opacity: 0 };
const HANDOVER_CAP_MS = 250;
const DRAWN_CAP_MS = 200;
const COVER_LOST_MS = DRAWN_CAP_MS + 300;
const ARCHIVE_RESIZE_SLACK = 0.5;
const HANDED_OVER_AWAY = 100_000;
const CARD_LANDED = 0.02;
const DECK_SCREEN_CORNER = iPhoneOr(() => DECK.displayCornerRadius, () => screenCornerRadius(DECK.displayCornerRadius));
const CHROME_BACK: MotionCurve = { type: "timing", durationMs: 0 };
const CHROME_GLASS_MS = 200;
const PAGE_MOUNT_AFTER_GROWTH_MS = 34;

const criticalSpringLandsMs = (response: number, within: number) => {
  let x = 1;
  for (let step = 0; step < 24; step++) x -= ((1 + x) * Math.exp(-x) - within) / (-x * Math.exp(-x));
  return (x * response * 1000) / (2 * Math.PI);
};
const COVERING_LANDING_CAP_MS = 2 * criticalSpringLandsMs(OPENING_CARD_RESPONSE, CARD_LANDED);
const ENTRANCE_PAINT_CAP_MS = 250;
const ENTRANCE_CAPTURE_CAP_MS = 180;

const DECK_RENDER_REACH = 6;
const DECK_GESTURE_REACH = 3;

const deckCardMounted = (index: number, anchor: number) => Math.abs(index - anchor) <= DECK_RENDER_REACH + DECK_GESTURE_REACH;
const BACKDROP_LEAD = 1.4;
const FLY_CLOCK_SPAN_MS = 600_000;
const LEAVE_SLACK_MS = 34;

const styles = StyleSheet.create({
  touch: { position: "absolute", left: 0, right: 0, top: 0 },
  bar: { position: "absolute", left: 0, right: 0 },
  hidden: { display: "none" },
});
