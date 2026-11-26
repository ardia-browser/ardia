import { probes } from "../../state/app/launchFlags";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_SHOWN, barShown, bottomBarCollapses, followScroll, obscuredBottom, pageInsets } from "../../lib/barCollapse";
import type { Design } from "../../lib/design";
import { neighbours, PAGER } from "../../lib/pagerPhysics";
import { useSystemBars } from "../../state/app/systemBars";
import { useNavigation, usePageTone } from "../../state/browse/hooks";
import { armDeckPull, beginDeckPull, deckCutOwns, deckPull, disarmDeckPull, pageBarPreviewShown, pageBarShown, pageBodyShown, previewPageBar, releaseDeckPull, trackDeckPull, usePageBarPreview, type PullSettled } from "../../state/browse/deckPull";
import { refreshHiddenDeck } from "../../state/browse/deckHold";
import { closePageMenu, editPageQuery, openDockedSiteSettings, openPageMenu } from "../../state/page/actions";
import { useDrawnMenuOpen, useFindOpen, useMenuDocked, usePressOpen, useReaderTabId } from "../../state/page/hooks";
import { ARRIVAL_COVER_ID, arriveAtNeighbour, holdBarAction, type BarAction, takeCommittedBarAction, captureCurrentCover, deckPullBegan, deckPullReleased, deckPullSettled, newTab, pageLaidOut, showDeck, swipeOrder, swipeToNeighbour, switchToNeighbour, useBrowse } from "../../state/browse/store";
import { useSearchFromDockedMenu, useSearchOpen } from "../../state/search/hooks";
import { shownPageTone, usePages } from "../../state/pages/store";
import { reportBarPill } from "../../state/search/stageBar";
import { searchStageIsNative } from "../../platform/searchStage";
import { usePreferences } from "../../state/settings/hooks";
import { closeFrontTab, menuOpenedHaptic, recentTabs, switchToTab, tabTitle } from "../../state/browse/tabMenus";
import { useBarOrder, useChromeTab, useIncognito, useSwipeIds, useTabWhile } from "../../state/tabs/hooks";
import { currentTabs, useTabs } from "../../state/tabs/store";
import { useShallow } from "zustand/react/shallow";
import { findTab } from "../../state/tabs/tabsState";
import { tabSwitchCuts } from "../../state/browse/tabSwitch";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { countUsage } from "../../state/telemetry/telemetry";
import {
  barCenterFromBottom,
  barHeight,
  browseLayout,
  chromeLayout,
  isDarkColor,
  Menu,
  Shade,
  rolesFor,
  space,
  tabsInk,
  tabsLayout,
  tabsMotion,
  floatingBarLayout,
  GlassBehind,
  GlassBranch,
  GlassSource,
  PAGE_FROST,
  pageReportsDrawn,
  useDesign,
  usePageUnderBars,
  usePresence,
  useTheme,
  type MenuItem,
  useReduceMotion,
} from "../ui";
import { BottomBar } from "./BottomBar";
import { barAddress, FloatingBar, spokenAddress, type HandOverFocus } from "./FloatingBar";
import { MaterialBarBand } from "./MaterialPageBar";
import { materialBarPill, materialBottomBar } from "../ui/materialTokens";
import { MaterialBarPill, useMaterialBarFold, useMaterialBarRegistration, useMaterialPillFold } from "./PersistentMaterialBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { HostPill, pillHoldAsked, pillSampleHold, useBarFold } from "./HostPill";
import { hostPillLayout } from "./hostPillTokens";
import { FindBar } from "./FindBar";
import { MaterialFindBar } from "./MaterialFindBar";
import { PageMenu, usesWarmPageMenu, WarmPageMenuHost } from "./PageMenu";
import { SystemPageMenuHost, usesSystemPageMenu } from "./SystemPageMenu";
import { PageRequestHost, PressMenu } from "./PageRequests";
import { ReaderView, useLeavingReader } from "./ReaderView";
import { PageFailureView } from "./PageFailureView";
import { DestinationFace, PageCover } from "./PageCover";
import { barFencedForDestination, destination, destinationAddresses, destinationFaceIds, destinationFaceKey, destinationHeldFill, destinationHeldUntil, destinationLiftPending, dropPreparedDestination, publishDestinationAddresses, releaseDestination, routeBarToDestination, useDestination, useDestinationFaces, type DestinationAddress } from "../../state/browse/destination";
import { HeldFrostSource } from "../ui/LookViews";
import { PageSurface } from "./PageSurface";
import { PagePull, PullBlocker, usePullBarShift } from "./PagePull";
import { redesignedBarCenterFromBottom } from "../../lib/deckGeometry";
import { useDemoMotion } from "./DemoMotion";
import { PagerAhead, PagerBackdrop, PagerNeighbour, useTabPager } from "./TabPager";
import { TabSwipeHint } from "./tabSwipeHint";
import { PageProgressLine } from "./PageProgressLine";
import { labTrace } from "../../platform/lab";
import { barIsDark, shownTone } from "../../lib/pageTone";
import { besideStrip, bottomBarLayout, DUO_BAR, duoSqueeze } from "../../lib/bottomBarSpan";
import { useScreenLayout } from "../../state/app/screenLayout";

export function BrowsingScreen({ tabId }: { tabId: string }) {
  const tab = useChromeTab(tabId);
  return tab ? <BrowsingPage tab={tab} /> : null;
}

function SystemBarsFor({ lightStatus, lightNavigation }: { lightStatus: boolean; lightNavigation: boolean }) {
  useSystemBars(lightStatus, lightNavigation);
  return null;
}

function PageSystemBars({ kept, lightStatus, lightNavigation }: { kept: boolean; lightStatus: boolean; lightNavigation: boolean }) {
  const deckUp = useBrowse((s) => kept && s.surface === "deck");
  return deckUp ? null : <SystemBarsFor lightStatus={lightStatus} lightNavigation={lightNavigation} />;
}

function PageBodyOwner({ kept }: { kept: boolean }) {
  const deckUp = useBrowse((s) => kept && s.surface === "deck");
  useLayoutEffect(() => {
    if (!kept) return;
    if (deckUp) {
      if (destinationLiftPending()) return;
      pageBodyShown.value = 0;
      pageBarShown.value = 0;
      return;
    }
    pageBodyShown.value = 1;
    pageBarShown.value = 1;
    pageBarPreviewShown.value = 0;
    previewPageBar(null);
    dropPreparedDestination();
  }, [kept, deckUp]);
  return null;
}

function DeckAddresses() {
  const open = useTabs((s) => s.open);
  const privates = useTabs((s) => s.privates);
  const theme = useTheme();
  const blank = usePageUnderBars() ? theme.pageSurface : theme.canvas;
  useEffect(() => {
    const table: Record<string, DestinationAddress> = {};
    const pages = usePages.getState();
    for (const tab of [...open, ...privates]) {
      const address = barAddress(tab);
      const fill = shownTone(shownPageTone(pages, tab.id), tab.themeColorHex)?.bottom ?? blank;
      table[tab.id] = { host: address.host, spoken: spokenAddress(address), isPrivate: address.isPrivate, insecure: address.insecure, fill };
    }
    publishDestinationAddresses(table);
  }, [open, privates, blank]);
  return null;
}

function usePageSourceHold(kept: boolean) {
  const held = useAnimatedProps<{ heldFill: string | null; heldUntil: string | null }>(() => {
    const lifted = destination.id.value;
    const bar = pageBarShown.value;
    const table = destinationAddresses.value;
    const cover = destination.cover.value;
    return { heldFill: kept ? destinationHeldFill(lifted, bar, table) : null, heldUntil: kept ? destinationHeldUntil(lifted, cover) : null };
  }, [kept]);
  return { held };
}

function useDestinationFaceIds(shownId: string) {
  const cards = useDestinationFaces((s) => s.cards);
  const deckShown = useBrowse((s) => s.surface === "deck");
  const prepared = useDestination((s) => s.prepared);
  const arriving = useDestination((s) => s.arriving);
  const key = destinationFaceIds(cards, shownId, deckShown, prepared, arriving).join("\n");
  return useMemo(() => (key === "" ? [] : key.split("\n")), [key]);
}

function DestinationSlot({ shownId, statusHeight, statusOver }: { shownId: string; statusHeight: number; statusOver: boolean }) {
  const ids = useDestinationFaceIds(shownId);
  const arriving = useDestination((s) => s.arriving);
  const cover = useDestination((s) => (s.arriving !== null && s.arriving === s.prepared ? s.cover : null));
  const spent = useDestination((s) => s.spent);
  useEffect(() => {
    const now = useDestination.getState().arriving;
    if (now !== null && currentTabs().selectedId !== now) releaseDestination(now);
  }, [shownId, arriving]);
  useEffect(() => () => releaseDestination(), []);
  return ids.map((id) => <PremountedFace key={destinationFaceKey(id, spent)} id={id} cover={id === arriving ? (cover ?? undefined) : undefined} statusHeight={statusHeight} statusOver={statusOver} />);
}

const PremountedFace = memo(function PremountedFace({ id, cover, statusHeight, statusOver }: { id: string; cover: string | undefined; statusHeight: number; statusOver: boolean }) {
  const tab = useTabWhile(id, true);
  return tab ? <DestinationFace tab={tab} cover={cover} statusHeight={statusHeight} statusOver={statusOver} /> : null;
});


type KeptBar = { preview: BrowserTab | null; standsIn: boolean; privateLook: boolean | undefined };

type KeptBarProps = { tab: BrowserTab; kept: boolean; pageDark: boolean; children: (kept: KeptBar, barDark: boolean) => ReactNode };

function KeptBarSlot({ tab, kept, pageDark, children }: KeptBarProps) {
  const deckUp = useBrowse((s) => kept && s.surface === "deck");
  const previewId = usePageBarPreview((s) => (kept ? s.id : null));
  const previewTab = useTabWhile(previewId ?? "", deckUp && previewId !== null && previewId !== tab.id);
  const preview = deckUp && previewTab ? previewTab : null;
  const deckPrivate = useIncognito();
  const keptBar = useMemo<KeptBar>(() => ({ preview, standsIn: kept && deckUp, privateLook: kept && deckUp ? deckPrivate : undefined }), [preview, kept, deckUp, deckPrivate]);
  const barDark = pageDark;
  const keptBarStyle = useAnimatedStyle(() => ({ opacity: kept ? pageBarShown.value : 1 }));
  const keptBarProps = useAnimatedProps<{ pointerEvents: "box-none" | "none"; importantForAccessibility: "auto" | "no-hide-descendants" }>(() => ({
    pointerEvents: !kept || pageBarShown.value > 0 ? "box-none" : "none",
    importantForAccessibility: !kept || pageBarShown.value > 0 ? "auto" : "no-hide-descendants",
  }));
  return (
    <Animated.View testID="keptPageBar" style={[StyleSheet.absoluteFill, keptBarStyle]} animatedProps={keptBarProps} pointerEvents="box-none" collapsable={false}>
      {children(keptBar, barDark)}
      {kept && deckUp ? <DeckAddresses /> : null}
    </Animated.View>
  );
}

const BODY_UNDER_DECK = 100_000;

const BrowsingPage = memo(function BrowsingPage({ tab }: { tab: BrowserTab }) {
  countRender("BrowsingScreen");
  const theme = useTheme();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const hinge = useScreenLayout((s) => s.hinge);
  const barSide = design === "redesigned" ? chromeLayout.barSideInset : browseLayout.barSideInset - 4;
  const barLayout = bottomBarLayout(width, insets, hinge, barSide);
  const { span: barSpan, strip } = barLayout;
  const controlsSpan = { left: barSpan.left - barSide, right: barSpan.right - barSide };
  const duoStrip = design === "redesigned" ? strip : null;
  const squeeze = duoStrip ? duoSqueeze(width, barLayout) : null;
  const safeSide = Math.max(insets.left, insets.right);
  const systemMenu = usesSystemPageMenu(design);
  const menuOpen = useDrawnMenuOpen(systemMenu);
  const menuDocked = useMenuDocked();
  const finding = useFindOpen();
  const readerId = useReaderTabId();
  const reader = useLeavingReader(readerId === tab.id ? tab.id : null);
  const pressing = usePressOpen();
  const tone = usePageTone(tab.id);
  const separatesIncognito = design !== "original";
  const barOrder = useBarOrder(separatesIncognito ? tab.isPrivate : null);
  const swipeIds = useSwipeIds(separatesIncognito ? tab.isPrivate : null);
  const searching = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const dockedSearch = design === "material" && menuDocked && searching && searchFromMenu;
  const [tabsMenu, setTabsMenu] = useState(false);
  const menu = usePresence(menuOpen || dockedSearch);
  useEffect(() => closePageMenu, [tab.id]);
  const lineKey = useBrowse(() => {
    const sameKind = separatesIncognito ? new Set(swipeIds) : null;
    return (sameKind ? swipeOrder().filter((id) => sameKind.has(id)) : swipeOrder()).join("|");
  });
  const swipeLine = useMemo(() => (lineKey ? lineKey.split("|") : []), [lineKey]);
  const aroundKey = useMemo(() => {
    const near = neighbours(swipeLine, tab.id);
    return `${near.left ?? ""}|${near.right ?? ""}`;
  }, [swipeLine, tab.id]);
  const around = useMemo(() => {
    const [leftId, rightId] = aroundKey.split("|");
    return { left: leftId || null, right: rightId || null };
  }, [aroundKey]);
  const left = useTabWhile(around.left ?? "", around.left !== null);
  const right = useTabWhile(around.right ?? "", around.right !== null);
  const cutsSwipe = tabSwitchCuts() && !probes("landed");
  const lineTabs = useLineTabs(cutsSwipe ? swipeLine : NO_LINE);
  const spokenLine = useMemo(() => Object.fromEntries(lineTabs.flatMap((each) => (each ? [[each.id, spokenAddress(barAddress(each))]] : []))) as Record<string, string>, [lineTabs]);
  const [swiping, setSwiping] = useState(false);
  const aheadCards = useMemo(() => (swiping ? cardsAhead(swipeLine, lineTabs, tab.id) : NO_AHEAD), [swiping, swipeLine, lineTabs, tab.id]);
  const runHeldAction = useCallback((id: string, action: BarAction) => {
    if (currentTabs().selectedId !== id) return;
    runBarAction(action);
  }, []);
  const handsOver = pageReportsDrawn();
  const grabbedSwipe = useCallback(() => {
    captureCurrentCover();
  }, []);
  const pager = useTabPager({
    width,
    selectedId: tab.id,
    left: left?.id ?? null,
    right: right?.id ?? null,
    order: swipeLine,
    landsEarly: handsOver,
    onHeld: runHeldAction,
    onSequence: cutsSwipe ? setSwiping : undefined,
    onCommit: handsOver ? arriveAtNeighbour : swipeToNeighbour,
    onGrab: grabbedSwipe,
  });
  useDemoMotion(pager, width);
  const swipeAddresses = useMemo(() => (tabSwitchCuts() && !probes("landed") ? { offset: pager.offset, from: pager.from, landed: pager.landed, cursor: pager.cursor, span: width, left, right, spoken: spokenLine } : null), [pager.offset, pager.from, pager.landed, pager.cursor, width, left, right, spokenLine]);
  const arrived = useBrowse((s) => s.arriving === tab.id && s.covered === tab.id);
  const arrivalTab = useTabWhile(tab.id, arrived);
  const arrivalCover = useBrowse((s) => s.arrivalCover);
  const failed = useNavigation(tab.id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const underBar = usePageUnderBars();
  const blankPage = underBar ? theme.pageSurface : theme.canvas;
  const top = pageTone?.top ?? blankPage;
  const bottom = pageTone?.bottom ?? blankPage;
  const barKept = tabSwitchCuts() && design === "redesigned";
  const sourceHold = usePageSourceHold(barKept);
  const barDark = barIsDark({ design, glassTone: failed ? undefined : tone?.barDark, toneBottom: pageTone?.bottom, themeDark: theme.dark, bottomDark: isDarkColor(bottom) });
  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: barKept && pageBodyShown.value === 0 ? BODY_UNDER_DECK : 0 }] }));
  const bodyProps = useAnimatedProps<{ pointerEvents: "box-none" | "none"; importantForAccessibility: "auto" | "no-hide-descendants" }>(() => ({
    pointerEvents: barKept && (pageBodyShown.value === 0 || deckCutOwns()) ? "none" : "box-none",
    importantForAccessibility: barKept && (pageBodyShown.value === 0 || deckCutOwns()) ? "no-hide-descendants" : "auto",
  }));
  const barSlotHeight = barHeight(insets.bottom, design);
  const collapse = useBarCollapse(tab.id, tab.isPrivate, finding, design, barSlotHeight, squeeze !== null);
  const duoBar = useMemo(() => (duoStrip ? { stripLeft: duoStrip.centerX - DUO_BAR.button / 2 - controlsSpan.left, stripTop: duoStrip.plus, squeeze, progress: collapse.fold.progress, collapsed: collapse.collapsed } : null), [duoStrip?.centerX, duoStrip?.plus, controlsSpan.left, squeeze?.marginLeft, squeeze?.marginRight, collapse.fold.progress, collapse.collapsed]);
  const folds = squeeze === null;
  const staged = design === "redesigned" && searchStageIsNative();
  useEffect(() => (staged && !collapse.hidden ? reportBarPill() : undefined), [staged, collapse.hidden]);
  const layout = underBar ? { pageBottom: 0, toneBottom: design === "material" ? 0 : barSlotHeight } : pageInsets(collapse.collapses, barSlotHeight, browseLayout.pageOverlap);
  const fullscreen = usePages((s) => s.fullscreen[tab.id] ?? false);
  const coveredBottom = obscuredBottom({ insetsScroll: Platform.OS === "ios", bar: barSlotHeight, collapses: collapse.collapses, cleared: fullscreen || finding || searching });
  const obscured = underBar ? { top: insets.top, bottom: coveredBottom } : undefined;
  const materialSummaryBottom = fullscreen || searching ? insets.bottom : collapse.collapsed ? insets.bottom + materialBottomBar.inset + materialBarPill.height : barSlotHeight;
  const summaryBottomInset = design === "material" ? materialSummaryBottom : undefined;
  const painted = useSharedValue(false);
  useEffect(() => {
    painted.value = true;
  }, [painted]);
  const openTabsMenu = useCallback(() => {
    if (barKept && barFencedForDestination(shownTab.current)) return;
    menuOpenedHaptic();
    setTabsMenu(true);
  }, [barKept]);
  const neighbourIds = useRef(around);
  neighbourIds.current = around;
  const shownTab = useRef(tab.id);
  shownTab.current = tab.id;
  const validatesStep = useRef(pager.validates);
  validatesStep.current = pager.validates;
  const stepTab = useCallback((delta: -1 | 1) => {
    if (barKept && barFencedForDestination(shownTab.current)) return;
    const id = delta < 0 ? neighbourIds.current.left : neighbourIds.current.right;
    if (!id || !validatesStep.current(shownTab.current, id)) return;
    switchToNeighbour(id);
  }, [barKept]);
  const landedTarget = useRef(pager.landedTarget);
  landedTarget.current = pager.landedTarget;
  const landedScope = useRef(pager.landedScope);
  landedScope.current = pager.landedScope;
  const heldFor = useCallback(() => {
    return tabSwitchCuts() ? landedTarget.current() : null;
  }, []);
  const editAddress = useCallback(() => {
    if (barKept && routeBarToDestination(shownTab.current, "address")) return;
    const landed = heldFor();
    if (landed) {
      holdBarAction(landed, "address", landedScope.current());
      return;
    }
    editPageQuery();
  }, [barKept]);
  const arrivedCover = useDestination((s) => (s.arriving === tab.id ? s.cover : null));
  useEffect(() => {
    const action = takeCommittedBarAction(tab.id);
    if (action) runBarAction(action);
  }, [tab.id, arrivedCover]);
  const heldOr = useCallback((action: BarAction, now: () => void) => () => {
    if (barKept && routeBarToDestination(shownTab.current, action)) return;
    const landed = heldFor();
    if (landed) {
      holdBarAction(landed, action, landedScope.current());
      return;
    }
    now();
  }, [barKept]);
  const tabsOrHeld = useMemo(() => heldOr("tabs", showDeck), [heldOr]);
  const plusOrHeld = useMemo(() => heldOr("plus", newTab), [heldOr]);
  const pageMenuOrHeld = useCallback(() => {
    if (barKept && routeBarToDestination(shownTab.current, "more")) return;
    const landed = heldFor();
    if (landed) {
      holdBarAction(landed, "more", landedScope.current());
      return;
    }
    openPageMenu();
  }, [barKept]);
  const incognito = useIncognito();
  const reduceMotion = useReduceMotion();
  const pulls = design === "redesigned";
  const tracks = pulls && !reduceMotion;
  useEffect(() => {
    if (!pulls) return;
    armDeckPull(tab.id, reduceMotion);
    return () => disarmDeckPull(tab.id, deckPullSettled);
  }, [pulls, reduceMotion, tab.id]);
  const barCenter = barCenterFromBottom(insets.bottom, design);
  const barTop = barCenter + floatingBarLayout.control / 2;
  const barShift = usePullBarShift(barTop, barCenter - redesignedBarCenterFromBottom(insets.bottom, Platform.OS));
  const swipesUp = !searching && !collapse.hidden && !(pulls && collapse.collapsed);
  const openDeckFromBar = () => {
    if (!incognito) countUsage("deck_bar_swipes");
    if (pulls) labTrace("PAGELAB bar swipe recognised with no pull to track");
    void showDeck();
  };
  const pullBegan = () => deckPullBegan(tab.id);
  const pullReleased = (lands: boolean) => deckPullReleased(tab.id, lands);
  const barPull = tracks ? { id: tab.id, prepare: refreshHiddenDeck, began: pullBegan, released: pullReleased, settled: deckPullSettled } : null;
  const hostPill = useRef<ViewInstance | null>(null);
  const pillHold = pillSampleHold(Platform.OS === "android", folds && collapse.collapsed, pillHoldAsked(), tab.id, tab.isPrivate, barDark);
  const handoverTarget: HandOverFocus["target"] = searching || menuOpen || dockedSearch || finding || fullscreen || pressing || tabsMenu || readerId === tab.id || collapse.hidden ? null : folds && collapse.collapsed ? "pill" : "address";
  const handover = useMemo(() => ({ target: handoverTarget, pill: hostPill }), [handoverTarget]);
  const barGesture = useMemo(() => Gesture.Race(pager.gesture, barSwipeUp(swipesUp, pager.active, openDeckFromBar, barPull, pulls && reduceMotion)), [pager.gesture, swipesUp, incognito, tracks, tab.id]);
  const toneTab = useRef(tab.id);
  const toneSwitchesTab = toneTab.current !== tab.id;
  useEffect(() => {
    toneTab.current = tab.id;
  }, [tab.id]);
  const statusStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value && !toneSwitchesTab ? withTiming(top, { duration: tabsMotion.barTone }) : top }), [top, toneSwitchesTab]);
  const barStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value && !toneSwitchesTab ? withTiming(bottom, { duration: tabsMotion.barTone }) : bottom }), [bottom, toneSwitchesTab]);
  const { scheme: materialScheme } = useMaterialTheme(tab.isPrivate);
  const pageMenu = systemMenu ? <SystemPageMenuHost tabId={tab.id} /> : usesWarmPageMenu(design, systemMenu) ? <WarmPageMenuHost tabId={tab.id} /> : menu.mounted ? <PageMenu tabId={tab.id} open={menuOpen} onHidden={menu.hidden} /> : null;
  const siteSettingsSheet = design === "material" && menuDocked ? pageMenu : null;
  const barBlocked = collapse.hidden || siteSettingsSheet !== null;
  const materialBarFold = useMaterialBarFold(design === "material" ? collapse.fold.progress : null);
  const materialPillFold = useMaterialPillFold(design === "material" ? collapse.fold.progress : null);
  const materialBarHosted = useMaterialBarRegistration("page", design === "material" ? {
    bar: { isTabOverview: false, scheme: materialScheme, tab, order: barOrder, showsPlus: !searching, addressDocked: siteSettingsSheet !== null, onTabs: showDeck, onTabsMenu: openTabsMenu, onStep: stepTab, onAddress: editAddress, onPlus: newTab, onMore: openPageMenu, onSiteSettings: openDockedSiteSettings },
    gesture: barGesture,
    tabId: tab.id,
    hidden: finding || fullscreen || (menu.mounted && !siteSettingsSheet) || readerId === tab.id || pressing || tabsMenu,
    blocked: barBlocked,
    collapse: { progress: collapse.hide, travel: collapse.travel },
    fold: { progress: collapse.fold.progress, collapsed: collapse.collapsed, expand: collapse.expand },
    siteSettingsSheet,
  } : null);

  return (
    <View style={[StyleSheet.absoluteFill, pulls ? null : { backgroundColor: theme.canvas }]} onLayout={() => pageLaidOut(tab.id)}>
      <Shade shaded={menuOpen || dockedSearch || readerId === tab.id || pressing || tabsMenu}>
        <Animated.View testID="pageBody" style={[StyleSheet.absoluteFill, bodyStyle]} animatedProps={bodyProps} pointerEvents="box-none" collapsable={false}>
        <HeldFrostSource testID="pageFrostSource" name={PAGE_FROST} animatedProps={barKept ? sourceHold.held : undefined} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
        <PageStack pulledTab={pulls ? tab.id : null} barTop={barTop}>
        <PagerBackdrop pager={pager} />
        <Animated.View style={[StyleSheet.absoluteFill, styles.outgoing, { backgroundColor: theme.canvas }, pager.outgoing]}>
          {underBar ? null : <Animated.View testID="pageStatusStrip" style={[{ height: insets.top }, statusStyle]} />}
          <View testID="pageArea" style={[styles.page, { marginBottom: layout.pageBottom }]}>
            <PageSurface key={tab.id} tab={tab} toneBottom={layout.toneBottom} obscured={obscured} summaryBottomInset={summaryBottomInset} pinsSafeArea={pulls ? true : undefined} />
            <PageCover key={`${tab.id}:cover`} tab={tab} />
            <PageFailureView key={`${tab.id}:failure`} tabId={tab.id} />
          </View>
          {underBar ? <Animated.View testID="pageStatusStrip" pointerEvents="none" style={[styles.statusOver, { height: insets.top }, statusStyle]} /> : null}
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: tabsInk.pagerBlack }, pager.dim]} pointerEvents="none" />
        </Animated.View>
        {pagerCards(left, right, arrived ? arrivalTab : null).map(({ card, side }) => (
          <PagerNeighbour key={card.id} pager={pager} tab={card} side={side} width={width} statusHeight={insets.top} statusOver={underBar} hasLeft={left !== null} hasRight={right !== null} coverId={arrivalCover ?? ARRIVAL_COVER_ID} />
        ))}
        {cutsSwipe ? aheadCards.map(({ card, side, inner }) => <PagerAhead key={`ahead:${card.id}`} pager={pager} tab={card} side={side} inner={inner} width={width} statusHeight={insets.top} statusOver={underBar} />) : null}
        <PageProgressLine tabId={tab.id} top={insets.top} />
        </PageStack>
        </HeldFrostSource>
        </Animated.View>
        {barKept ? <DestinationSlot shownId={tab.id} statusHeight={insets.top} statusOver={underBar} /> : null}
        <GlassSource name={PAGE_FROST}>
        {materialBarHosted && design === "material" ? null : (
        <KeptBarSlot tab={tab} kept={barKept} pageDark={barDark}>
        {(keptBar, barDark) => (
        <GestureDetector gesture={barGesture}>
          <Animated.View
            testID="pageBar"
            pointerEvents={barBlocked ? "none" : design === "redesigned" || design === "material" ? "box-none" : "auto"} collapsable={false}
            importantForAccessibility={barBlocked ? "no-hide-descendants" : "auto"}
            accessibilityElementsHidden={barBlocked}
            style={[styles.bar, { height: barHeight(insets.bottom, design) }, underBar ? null : barStyle, finding && design === "material" ? styles.replacedBar : collapse.style]}
          >
            {design === "redesigned" ? (
              <Animated.View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2, ...controlsSpan }, pulls ? barShift : null]} pointerEvents="box-none">
                <Animated.View
                  testID="floatingBarFold"
                  collapsable={false}
                  needsOffscreenAlphaCompositing={Platform.OS === "android"}
                  style={folds ? collapse.fold.bar : null}
                  pointerEvents={folds && collapse.collapsed ? "none" : "box-none"}
                  importantForAccessibility={folds && collapse.collapsed ? "no-hide-descendants" : "auto"}
                  accessibilityElementsHidden={folds && collapse.collapsed}
                >
                  <GlassBranch attached={!folds || collapse.fold.attached.bar}>
                  <GlassBehind />
                  <FoldLayer testID="floatingBarFoldLayer" textured={!folds || collapse.fold.attached.bar}>
                  <FloatingBar
                    tab={tab}
                    preview={keptBar.preview}
                    standsIn={keptBar.standsIn}
                    privateLook={keptBar.privateLook}
                    order={barOrder}
                    roles={rolesFor(barDark)}
                    dark={barDark}
                    showsPlus={staged || !searching}
                    anchors={!folds || !collapse.collapsed}
                    duo={duoBar}
                    fold={folds ? collapse.fold.barLook : null}
                    swipe={swipeAddresses}
                    handover={handover}
                    onTabs={tabsOrHeld}
                    onTabsMenu={openTabsMenu}
                    onStep={stepTab}
                    onAddress={editAddress}
                    onPlus={plusOrHeld}
                    onMore={pageMenuOrHeld}
                  />
                  </FoldLayer>
                  </GlassBranch>
                </Animated.View>
                {folds ? (
                  <Animated.View
                    ref={hostPill}
                    testID="hostPillFold"
                    collapsable={false}
                    needsOffscreenAlphaCompositing={Platform.OS === "android"}
                    style={[styles.pillPlace, collapse.fold.pill]}
                    pointerEvents={collapse.collapsed ? "box-none" : "none"}
                    importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"}
                    accessibilityElementsHidden={!collapse.collapsed}
                  >
                    <GlassBranch attached={collapse.fold.attached.pill}>
                    <GlassBehind />
                    <FoldLayer testID="hostPillFoldLayer" textured={collapse.fold.attached.pill} style={styles.pillLayer}>
                      <HostPill tab={tab} dark={barDark} shown={collapse.fold.pillGlass} anchors={collapse.collapsed} sampleHold={pillHold} contentStyle={collapse.fold.pillContent} onExpand={collapse.expand} />
                    </FoldLayer>
                    </GlassBranch>
                  </Animated.View>
                ) : null}
              </Animated.View>
            ) : design === "material" ? (
              <>
                <Animated.View testID="materialBarFold" collapsable={false} style={[StyleSheet.absoluteFill, materialBarFold]} pointerEvents={collapse.collapsed ? "none" : "box-none"} importantForAccessibility={collapse.collapsed ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={collapse.collapsed}>
                  <MaterialBarBand tab={tab} order={barOrder} showsPlus={!searching} addressDocked={siteSettingsSheet !== null} safeSide={safeSide} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onAddress={editAddress} onPlus={newTab} onMore={openPageMenu} onSiteSettings={openDockedSiteSettings} />
                </Animated.View>
                <Animated.View testID="materialBarPillPlace" collapsable={false} style={[styles.materialPillPlace, { bottom: insets.bottom + materialBottomBar.inset - materialBarPill.shadowRoom, left: safeSide + materialBottomBar.edge, right: safeSide + materialBottomBar.edge }, materialPillFold]} pointerEvents={collapse.collapsed ? "box-none" : "none"} importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!collapse.collapsed}>
                  <MaterialBarPill tab={tab} scheme={materialScheme} onExpand={collapse.expand} />
                </Animated.View>
              </>
            ) : (
              <>
                <View style={[StyleSheet.absoluteFill, { backgroundColor: barDark ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} />
                <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - browseLayout.hitTarget / 2, ...controlsSpan }]}>
                  <BottomBar order={barOrder} roles={rolesFor(barDark)} showsPlus={!searching} incognito={tab.isPrivate} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onPlus={newTab} onMore={openPageMenu} />
                </View>
              </>
            )}
          </Animated.View>
        </GestureDetector>
        )}
        </KeptBarSlot>
        )}
        </GlassSource>
        {finding && design !== "material" ? <FindBar tabId={tab.id} /> : null}
        {pulls ? <PullBlocker /> : null}
      </Shade>
      {finding && design === "material" ? <MaterialFindBar tabId={tab.id} /> : null}
      {tabsMenu ? (
        <Menu
          items={tabsMenuItems(barOrder)}
          place={duoStrip ? { bottom: barCenterFromBottom(insets.bottom, design) - DUO_BAR.button / 2, ...besideStrip(duoStrip, width, tabsLayout.menuWidth, space.l) } : { bottom: barHeight(insets.bottom, design) + space.xs, left: space.l, width: Math.min(tabsLayout.menuWidth, width - space.l * 2) }}
          frost={null}
          glassSource={PAGE_FROST}
          privately={tab.isPrivate}
          onDismiss={() => setTabsMenu(false)}
        />
      ) : null}
      <PressMenu width={width} height={height} glassSource={PAGE_FROST} />
      {materialBarHosted && siteSettingsSheet ? null : pageMenu}
      {reader.shown ? <ReaderView tabId={reader.shown} closing={reader.closing} /> : null}
      <PageRequestHost tabId={tab.id} />
      <PageBodyOwner kept={barKept} />
      <PageSystemBars kept={barKept} lightStatus={isDarkColor(top)} lightNavigation={barDark} />
      {Platform.OS === "android" ? <TabSwipeHint pager={pager} toward={right ? 1 : left ? -1 : 0} tabId={tab.id} calm={!searching && !menuOpen && !finding && !tabsMenu && !fullscreen && readerId !== tab.id && !collapse.hidden && !pressing} /> : null}
    </View>
  );
});


const NO_LINE: string[] = [];

const AHEAD_SLOTS = [2, 3, 4];

const NO_AHEAD: { card: BrowserTab; side: -1 | 1; inner: string }[] = [];

function runBarAction(action: BarAction) {
  if (action === "address") editPageQuery();
  else if (action === "more") openPageMenu();
  else if (action === "plus") newTab();
  else if (action === "tabs") void showDeck();
}

function useLineTabs(ids: readonly string[]): (BrowserTab | null)[] {
  return useTabs(useShallow((state) => ids.map((id) => findTab(state, id) ?? null)));
}

export function cardsAhead(line: readonly string[], tabs: readonly (BrowserTab | null)[], shownId: string): { card: BrowserTab; side: -1 | 1; inner: string }[] {
  const at = line.indexOf(shownId);
  if (at < 0 || tabs.length !== line.length) return [];
  const cards: { card: BrowserTab; side: -1 | 1; inner: string }[] = [];
  for (const side of [-1, 1] as const)
    for (const slot of AHEAD_SLOTS) {
      const card = tabs[at + side * slot];
      const inner = line[at + side * (slot - 1)];
      if (card && inner) cards.push({ card, side, inner });
    }
  return cards;
}

function pagerCards(left: BrowserTab | null, right: BrowserTab | null, arrival: BrowserTab | null): { card: BrowserTab; side: -1 | 0 | 1 }[] {
  const cards: { card: BrowserTab; side: -1 | 0 | 1 }[] = [];
  if (arrival) cards.push({ card: arrival, side: 0 });
  if (left) cards.push({ card: left, side: -1 });
  if (right) cards.push({ card: right, side: 1 });
  return cards;
}

function PageStack({ pulledTab, barTop, children }: { pulledTab: string | null; barTop: number; children: ReactNode }) {
  if (pulledTab) return <PagePull tabId={pulledTab} barTop={barTop}>{children}</PagePull>;
  return children;
}

function useBarCollapse(tabId: string, isPrivate: boolean, finding: boolean, design: Design, height: number, squeezes: boolean) {
  const folds = design === "redesigned" || design === "material";
  const collapses = bottomBarCollapses(design, usePreferences((p) => p.collapsesBottomBar)) || squeezes;
  const materialFind = design === "material" && finding;
  const followsScroll = collapses && !materialFind;
  const direction = useNavigation(tabId, (n) => n?.scrollDirection ?? "up");
  const page = useNavigation(tabId, (n) => n?.url ?? null);
  const reduceMotion = useReduceMotion();
  const [state, setState] = useState(() => followScroll(BAR_SHOWN, tabId, page, direction, followsScroll));
  const android = Platform.OS === "android";
  const followed = followScroll(state, tabId, page, direction, followsScroll);
  if (followed !== state) setState(followed);
  const scrolledAway = followed.hidden && followed.tabId === tabId;
  const collapsed = folds && scrolledAway && !finding;
  const hidden = finding || (!folds && scrolledAway);
  const slidesAway = hidden && !materialFind;
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (collapsed && !wasCollapsed.current && !isPrivate) countUsage("bottom_bar_collapses");
    wasCollapsed.current = collapsed;
  }, [collapsed, tabId, isPrivate, squeezes]);
  const fold = useBarFold(collapsed, reduceMotion);
  const hide = useSharedValue(0);
  useEffect(() => {
    if (android && reduceMotion) {
      hide.value = slidesAway ? 1 : 0;
      return;
    }
    hide.value = reduceMotion ? withTiming(slidesAway ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(slidesAway ? 1 : 0, tabsMotion.barCollapse);
  }, [slidesAway, reduceMotion]);
  const travel = design === "material" ? height : browseLayout.barCollapseTravel;
  const style = useAnimatedStyle(() => ({ opacity: 1 - hide.value, transform: [{ translateY: hide.value * travel }] }), [travel]);
  const expand = () => setState(barShown);
  return { collapses, hidden, collapsed, fold, expand, style, hide, travel };
}

function tabsMenuItems(order: BrowserTab[]): MenuItem[] {
  const others = recentTabs(order).map((tab): MenuItem => ({ label: tabTitle(tab), onPress: () => switchToTab(tab.id) }));
  return [...others, ...(others.length ? ["divider" as const] : []), { label: "Close Tab", icon: "xmark", destructive: true, onPress: closeFrontTab }];
}

export type BarPull = { id: string; prepare: () => void; began: () => void; released: (lands: boolean) => void; settled: PullSettled };

export function barSwipeUp(enabled: boolean, pagerActive: { value: number }, open: () => void, pull: BarPull | null = null, primes = false) {
  const pan = Gesture.Pan()
    .withTestId("barSwipeUp")
    .enabled(enabled)
    .activeOffsetY(-browseLayout.barSwipeUp)
    .failOffsetY(PAGER.minimumDistance)
    .failOffsetX([-PAGER.minimumDistance, PAGER.minimumDistance]);
  if (!pull) {
    const opens = pan.onStart(() => {
      if (pagerActive.value) return;
      runOnJS(open)();
    });
    if (!primes) return opens;
    return opens
      .onBegin(() => {
        deckPull.warm.value = true;
        deckPull.primed.value = true;
      })
      .onFinalize(() => {
        deckPull.warm.value = false;
        deckPull.primed.value = false;
      });
  }
  const { id, prepare, began, released, settled } = pull;
  const cutsAtRelease = tabSwitchCuts();
  const frameRelease = Platform.OS === "android" && !cutsAtRelease;
  return pan
    .onBegin(() => {
      deckPull.warm.value = true;
      if (deckPull.target.value?.id !== id) runOnJS(prepare)();
    })
    .onStart((event) => {
      if (pagerActive.value) return;
      if (!beginDeckPull(id, event.translationY)) {
        runOnJS(open)();
        return;
      }
      runOnJS(began)();
    })
    .onUpdate((event) => {
      trackDeckPull(event.translationY);
    })
    .onFinalize((event, success) => {
      deckPull.warm.value = false;
      const velocity = Number.isFinite(event.velocityY) ? event.velocityY : 0;
      if (frameRelease) {
        requestAnimationFrame(() => {
          "worklet";
          releaseDeckPull(id, velocity, success, released, settled);
        });
      } else {
        releaseDeckPull(id, velocity, success, released, settled, cutsAtRelease);
      }
    });
}


const styles = StyleSheet.create({
  outgoing: { overflow: "hidden" },
  page: { flex: 1 },
  statusOver: { position: "absolute", left: 0, right: 0, top: 0 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  replacedBar: { opacity: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
  materialPillPlace: { position: "absolute", height: materialBarPill.height + materialBarPill.shadowRoom * 2, paddingVertical: materialBarPill.shadowRoom, alignItems: "center", justifyContent: "flex-end" },
  pillPlace: { position: "absolute", left: 0, right: 0, bottom: 0, height: hostPillLayout.height, alignItems: "center", justifyContent: "flex-end" },
  pillLayer: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "flex-end" },
});

function FoldLayer({ testID, textured, style, children }: { testID: string; textured: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <View testID={testID} collapsable={false} renderToHardwareTextureAndroid={Platform.OS === "android" && textured} pointerEvents="box-none" style={style}>
      {children}
    </View>
  );
}
