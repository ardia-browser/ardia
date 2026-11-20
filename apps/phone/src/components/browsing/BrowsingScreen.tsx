import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_SHOWN, barShown, followScroll, obscuredBottom, pageInsets } from "../../lib/barCollapse";
import { neighbours, PAGER } from "../../lib/pagerPhysics";
import { useSystemBars } from "../../state/app/systemBars";
import { useFrozenOrder, useNavigation, usePageTone, watchPageLoad } from "../../state/browse/hooks";
import { armDeckPull, beginDeckPull, deckPull, disarmDeckPull, releaseDeckPull, trackDeckPull, type PullSettled } from "../../state/browse/deckPull";
import { refreshHiddenDeck } from "../../state/browse/deckHold";
import { closePageMenu, editPageQuery, openPageMenu } from "../../state/page/actions";
import { useFindOpen, useMenuOpen, usePressOpen, useReaderTabId } from "../../state/page/hooks";
import { captureCurrentCover, deckPullBegan, deckPullReleased, deckPullSettled, newTab, pageLaidOut, showDeck, swipeOrder, switchToNeighbour } from "../../state/browse/store";
import { useSearchOpen } from "../../state/search/hooks";
import { usePages } from "../../state/pages/store";
import { reportBarPill } from "../../state/search/stageBar";
import { searchStageIsNative } from "../../platform/searchStage";
import { usePreferences } from "../../state/settings/hooks";
import { closeFrontTab, menuOpenedHaptic, recentTabs, switchToTab, tabTitle } from "../../state/browse/tabMenus";
import { useDeckOrder, useIncognito } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { countUsage } from "../../state/telemetry/telemetry";
import {
  barCenterFromBottom,
  barHeight,
  browseLayout,
  ink,
  isDarkColor,
  LoadingLine,
  type LoadWatch,
  Menu,
  Shade,
  rolesFor,
  space,
  tabsInk,
  tabsLayout,
  tabsMotion,
  floatingBarLayout,
  useDesign,
  usePageUnderBars,
  usePresence,
  useTheme,
  type MenuItem,
  useReduceMotion,
} from "../ui";
import { BottomBar } from "./BottomBar";
import { FloatingBar } from "./FloatingBar";
import { HostPill, useBarFold } from "./HostPill";
import { hostPillLayout } from "./hostPillTokens";
import { FindBar } from "./FindBar";
import { PageMenu } from "./PageMenu";
import { PageRequestHost, PressMenu } from "./PageRequests";
import { ReaderView } from "./ReaderView";
import { PageFailureView } from "./PageFailureView";
import { PageCover } from "./PageCover";
import { PageSurface } from "./PageSurface";
import { PagePull, PullBlocker, usePullBarShift } from "./PagePull";
import { redesignedBarCenterFromBottom } from "../../lib/deckGeometry";
import { useDemoMotion } from "./DemoMotion";
import { PagerBackdrop, PagerNeighbour, useTabPager } from "./TabPager";
import { launchArguments } from "../../state/app/launchFlags";
import { labTrace } from "../../platform/lab";
import { columnContentWidth, SCREEN_COLUMN, type ScreenColumn } from "../../state/app/screenLayout";
import { BrowsingColumn } from "../column/BrowsingColumn";
import { columnMenuPlace, columnPadding, useColumn } from "../column/SideColumn";
import { shownTone } from "../../lib/pageTone";

export const BrowsingScreen = memo(function BrowsingScreen({ tab }: { tab: BrowserTab }) {
  countRender("BrowsingScreen");
  const theme = useTheme();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const safeSide = Math.max(insets.left, insets.right);
  const column = useColumn();
  const pageWidth = column ? columnContentWidth(column, width) : width;
  const menuOpen = useMenuOpen();
  const finding = useFindOpen();
  const readerId = useReaderTabId();
  const pressing = usePressOpen();
  const tone = usePageTone(tab.id);
  const order = useDeckOrder();
  const barOrder = useMemo(() => (design === "redesigned" && !column ? order.filter((other) => other.isPrivate === tab.isPrivate) : order), [order, design, column, tab.isPrivate]);
  const frozen = useFrozenOrder();
  const searching = useSearchOpen();
  const [tabsMenu, setTabsMenu] = useState(false);
  const menu = usePresence(menuOpen);
  useEffect(() => closePageMenu, [tab.id]);
  const byId = useMemo(() => new Map(order.map((t) => [t.id, t])), [order]);
  const around = useMemo(() => neighbours(swipeOrder(), tab.id), [order, frozen, tab.id]);
  const left = around.left ? (byId.get(around.left) ?? null) : null;
  const right = around.right ? (byId.get(around.right) ?? null) : null;
  const pager = useTabPager({
    width: pageWidth,
    selectedId: tab.id,
    left: left?.id ?? null,
    right: right?.id ?? null,
    onCommit: switchToNeighbour,
    onGrab: captureCurrentCover,
  });
  useDemoMotion(pager, pageWidth);
  const failed = useNavigation(tab.id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const top = pageTone?.top ?? theme.surface;
  const bottom = pageTone?.bottom ?? theme.surface;
  const barDark = design === "redesigned" && !pageTone?.bottom ? theme.dark : isDarkColor(bottom);
  useSystemBars(isDarkColor(top), barDark);
  const collapse = useBarCollapse(tab.id, finding, design === "redesigned");
  const staged = design === "redesigned" && !column && searchStageIsNative();
  useEffect(() => (staged && !collapse.hidden ? reportBarPill() : undefined), [staged, collapse.hidden]);
  const underBar = usePageUnderBars();
  const layout = column ? COLUMN_PAGE : underBar ? { pageBottom: 0, toneBottom: barHeight(insets.bottom, design) } : pageInsets(collapse.collapses, barHeight(insets.bottom, design), browseLayout.pageOverlap);
  const fullscreen = usePages((s) => s.fullscreen[tab.id] ?? false);
  const coveredBottom = obscuredBottom({ follows: Platform.OS === "android", bar: barHeight(insets.bottom, design), pill: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2 + hostPillLayout.height, collapsed: collapse.collapsed, cleared: fullscreen || finding || searching });
  const obscured = column ? COLUMN_OBSCURED : underBar ? { top: insets.top, bottom: coveredBottom } : undefined;
  const painted = useSharedValue(false);
  useEffect(() => {
    painted.value = true;
  }, [painted]);
  const openTabsMenu = () => {
    menuOpenedHaptic();
    setTabsMenu(true);
  };
  const stepTab = (delta: -1 | 1) => {
    const id = delta < 0 ? left?.id : right?.id;
    if (id) switchToNeighbour(id);
  };
  const incognito = useIncognito();
  const reduceMotion = useReduceMotion();
  const pulls = design === "redesigned" && !column;
  const tracks = pulls && !reduceMotion;
  useEffect(() => {
    if (!pulls) return;
    armDeckPull(tab.id, reduceMotion);
    return () => disarmDeckPull(tab.id, deckPullSettled);
  }, [pulls, reduceMotion, tab.id]);
  const barCenter = barCenterFromBottom(insets.bottom, design);
  const barTop = barCenter + floatingBarLayout.control / 2;
  const barShift = usePullBarShift(barTop, barCenter - redesignedBarCenterFromBottom(insets.bottom, Platform.OS));
  const swipesUp = !column && !searching && !collapse.hidden && !(pulls && collapse.collapsed);
  const openDeckFromBar = () => {
    if (!incognito) countUsage("deck_bar_swipes");
    if (pulls) labTrace("PAGELAB bar swipe recognised with no pull to track");
    void showDeck();
  };
  const pullBegan = () => deckPullBegan(tab.id);
  const pullReleased = (lands: boolean) => deckPullReleased(tab.id, lands);
  const barPull = tracks ? { id: tab.id, prepare: refreshHiddenDeck, began: pullBegan, released: pullReleased, settled: deckPullSettled } : null;
  const barGesture = useMemo(() => Gesture.Race(pager.gesture, barSwipeUp(swipesUp, pager.active, openDeckFromBar, barPull, pulls && reduceMotion)), [pager.gesture, swipesUp, incognito, tracks, tab.id]);
  const statusStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(top, { duration: tabsMotion.barTone }) : top }), [top]);
  const barStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(bottom, { duration: tabsMotion.barTone }) : bottom }), [bottom]);
  return (
    <View style={[StyleSheet.absoluteFill, pulls ? null : { backgroundColor: column ? (theme.dark ? ink.black : ink.white) : theme.surface }]} onLayout={() => pageLaidOut(tab.id)}>
      <Shade shaded={menuOpen || readerId === tab.id || pressing || tabsMenu}>
        <PageStack column={column} pulledTab={pulls ? tab.id : null} barTop={barTop}>
        <PagerBackdrop />
        <Animated.View style={[StyleSheet.absoluteFill, styles.outgoing, { backgroundColor: theme.surface }, pager.outgoing]}>
          {underBar ? null : <Animated.View testID="pageStatusStrip" style={[{ height: insets.top }, statusStyle]} />}
          <View testID="pageArea" style={[styles.page, { marginBottom: layout.pageBottom }]}>
            <PageSurface key={tab.id} tab={tab} toneBottom={layout.toneBottom} obscured={obscured} pinsSafeArea={pulls ? true : undefined} />
            <PageCover key={`${tab.id}:cover`} tab={tab} />
            <PageFailureView key={`${tab.id}:failure`} tabId={tab.id} />
          </View>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: tabsInk.pagerBlack }, pager.dim]} pointerEvents="none" />
        </Animated.View>
        {left ? <PagerNeighbour pager={pager} tab={left} side={-1} width={pageWidth} statusHeight={insets.top} hasLeft hasRight={right !== null} /> : null}
        {right ? <PagerNeighbour pager={pager} tab={right} side={1} width={pageWidth} statusHeight={insets.top} hasLeft={left !== null} hasRight /> : null}
        <View style={[styles.loading, { top: insets.top }]} pointerEvents="none">
          <PageLoadingLine tabId={tab.id} color={theme.accent} />
        </View>
        </PageStack>
        {column ? (
          <BrowsingColumn
            column={column}
            width={width}
            tab={tab}
            order={order}
            roles={rolesFor(theme.dark)}
            dark={theme.dark}
            hidden={finding}
            onTabs={showDeck}
            onTabsMenu={openTabsMenu}
            onStep={stepTab}
            onAddress={editPageQuery}
            onPlus={newTab}
            onMore={openPageMenu}
          />
        ) : (
          <GestureDetector gesture={barGesture}>
            <Animated.View
              testID="pageBar"
              pointerEvents={collapse.hidden ? "none" : design === "redesigned" ? "box-none" : "auto"} collapsable={false}
              importantForAccessibility={collapse.hidden ? "no-hide-descendants" : "auto"}
              accessibilityElementsHidden={collapse.hidden}
              style={[styles.bar, { height: barHeight(insets.bottom, design) }, underBar ? null : barStyle, collapse.style]}
            >
              {design === "redesigned" ? (
                <Animated.View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2, paddingHorizontal: safeSide }, pulls ? barShift : null]} pointerEvents="box-none">
                  <Animated.View
                    testID="floatingBarFold"
                    collapsable={false}
                    style={collapse.fold.bar}
                    pointerEvents={collapse.collapsed ? "none" : "box-none"}
                    importantForAccessibility={collapse.collapsed ? "no-hide-descendants" : "auto"}
                    accessibilityElementsHidden={collapse.collapsed}
                  >
                    <FloatingBar
                      tab={tab}
                      order={barOrder}
                      roles={rolesFor(barDark)}
                      dark={barDark}
                      showsPlus={staged || !searching}
                      anchors={!collapse.collapsed}
                      onTabs={showDeck}
                      onTabsMenu={openTabsMenu}
                      onStep={stepTab}
                      onAddress={editPageQuery}
                      onPlus={newTab}
                      onMore={openPageMenu}
                    />
                  </Animated.View>
                  {collapse.fold.pillMounted ? (
                    <Animated.View
                      testID="hostPillFold"
                    collapsable={false}
                      style={[styles.pillPlace, collapse.fold.pill]}
                      pointerEvents={collapse.collapsed ? "box-none" : "none"}
                      importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"}
                      accessibilityElementsHidden={!collapse.collapsed}
                    >
                      <HostPill tab={tab} dark={barDark} shown={collapse.collapsed} anchors={collapse.collapsed} contentStyle={collapse.fold.pillContent} onExpand={collapse.expand} />
                    </Animated.View>
                  ) : null}
                </Animated.View>
              ) : (
                <>
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: barDark ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} />
                  <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - browseLayout.hitTarget / 2, paddingHorizontal: safeSide }]}>
                    <BottomBar order={order} roles={rolesFor(barDark)} showsPlus={!searching} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onPlus={newTab} onMore={openPageMenu} />
                  </View>
                </>
              )}
            </Animated.View>
          </GestureDetector>
        )}
        {finding ? <FindBar tabId={tab.id} /> : null}
        {pulls ? <PullBlocker /> : null}
      </Shade>
      {tabsMenu ? (
        <Menu
          items={tabsMenuItems(barOrder)}
          place={column ? { ...columnMenuPlace(column, width, SCREEN_COLUMN.top), width: Math.min(tabsLayout.menuWidth, pageWidth - space.l * 2) } : { bottom: barHeight(insets.bottom, design) + space.xs, left: space.l, width: Math.min(tabsLayout.menuWidth, width - space.l * 2) }}
          frost={null}
          onDismiss={() => setTabsMenu(false)}
        />
      ) : null}
      <PressMenu width={width} height={height} />
      {menu.mounted ? <PageMenu tabId={tab.id} open={menuOpen} onHidden={menu.hidden} /> : null}
      {readerId === tab.id ? <ReaderView tabId={tab.id} /> : null}
      <PageRequestHost tabId={tab.id} />
    </View>
  );
});


const COLUMN_PAGE = { pageBottom: 0, toneBottom: 0 };
const COLUMN_OBSCURED = { top: 0, bottom: 0 };

function PageStack({ column, pulledTab, barTop, children }: { column: ScreenColumn | null; pulledTab: string | null; barTop: number; children: ReactNode }) {
  if (pulledTab) return <PagePull tabId={pulledTab} barTop={barTop}>{children}</PagePull>;
  if (!column) return children;
  return (
    <View testID="columnPageStack" style={[styles.columnPage, columnPadding(column)]}>
      {children}
    </View>
  );
}

function useBarCollapse(tabId: string, finding: boolean, folds: boolean) {
  const collapses = usePreferences((p) => p.collapsesBottomBar);
  const direction = useNavigation(tabId, (n) => n?.scrollDirection ?? "up");
  const page = useNavigation(tabId, (n) => n?.url ?? null);
  const reduceMotion = useReduceMotion();
  const [state, setState] = useState(() => followScroll(BAR_SHOWN, tabId, page, direction, collapses));
  useEffect(() => setState((now) => followScroll(now, tabId, page, direction, collapses)), [tabId, page, direction, collapses]);
  const scrolledAway = state.hidden && state.tabId === tabId;
  const collapsed = folds && scrolledAway && !finding;
  const hidden = finding || (!folds && scrolledAway);
  const fold = useBarFold(collapsed, reduceMotion);
  const hide = useSharedValue(0);
  useEffect(() => {
    hide.value = reduceMotion ? withTiming(hidden ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(hidden ? 1 : 0, tabsMotion.barCollapse);
  }, [hidden, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: 1 - hide.value, transform: [{ translateY: hide.value * browseLayout.barCollapseTravel }] }));
  const expand = () => setState(barShown);
  return { collapses, hidden, collapsed, fold, expand, style };
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
  const frameRelease = Platform.OS === "android";
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
        releaseDeckPull(id, velocity, success, released, settled);
      }
    });
}

function PageLoadingLine({ tabId, color }: { tabId: string; color: string }) {
  const watch = useMemo<LoadWatch>(() => {
    const loadFreeze = launchArguments().loadFreeze;
    if (loadFreeze !== null) return (show) => (show(loadFreeze, true), () => undefined);
    return (show) => watchPageLoad(tabId, show);
  }, [tabId]);
  return <LoadingLine watch={watch} color={color} />;
}


const styles = StyleSheet.create({
  outgoing: { overflow: "hidden" },
  page: { flex: 1 },
  loading: { position: "absolute", left: 0, right: 0 },
  columnPage: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, overflow: "hidden" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
  pillPlace: { position: "absolute", left: 0, right: 0, bottom: 0, height: hostPillLayout.height, alignItems: "center", justifyContent: "flex-end" },
});
