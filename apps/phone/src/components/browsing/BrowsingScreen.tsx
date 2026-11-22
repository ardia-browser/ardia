import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_SHOWN, barShown, bottomBarCollapses, followScroll, obscuredBottom, pageInsets } from "../../lib/barCollapse";
import type { Design } from "../../lib/design";
import { neighbours, PAGER } from "../../lib/pagerPhysics";
import { useSystemBars } from "../../state/app/systemBars";
import { useFrozenOrder, useNavigation, usePageTone, watchPageLoad } from "../../state/browse/hooks";
import { armDeckPull, beginDeckPull, deckPull, disarmDeckPull, releaseDeckPull, trackDeckPull, type PullSettled } from "../../state/browse/deckPull";
import { refreshHiddenDeck } from "../../state/browse/deckHold";
import { closePageMenu, editPageQuery, openDockedSiteSettings, openPageMenu } from "../../state/page/actions";
import { useFindOpen, useMenuDocked, useMenuOpen, usePressOpen, useReaderTabId } from "../../state/page/hooks";
import { ARRIVAL_COVER_ID, arriveAtNeighbour, captureCurrentCover, deckPullBegan, deckPullReleased, deckPullSettled, newTab, pageLaidOut, showDeck, swipeOrder, swipeToNeighbour, switchToNeighbour, useBrowse } from "../../state/browse/store";
import { useSearchFromDockedMenu, useSearchOpen } from "../../state/search/hooks";
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
  chromeLayout,
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
  pageReportsDrawn,
  useDesign,
  usePageUnderBars,
  usePresence,
  useTheme,
  type MenuItem,
  useReduceMotion,
} from "../ui";
import { BottomBar } from "./BottomBar";
import { FloatingBar } from "./FloatingBar";
import { MaterialBarBand } from "./MaterialPageBar";
import { materialBarPill, materialBottomBar } from "../ui/materialTokens";
import { MaterialBarPill, useMaterialBarFold, useMaterialBarRegistration, useMaterialPillFold } from "./PersistentMaterialBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { HostPill, useBarFold } from "./HostPill";
import { hostPillLayout } from "./hostPillTokens";
import { BarBase } from "./BarBase";
import { FindBar } from "./FindBar";
import { MaterialFindBar } from "./MaterialFindBar";
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
import { TabSwipeHint } from "./tabSwipeHint";
import { launchArguments } from "../../state/app/launchFlags";
import { labTrace } from "../../platform/lab";
import { shownTone } from "../../lib/pageTone";
import { besideStrip, bottomBarLayout, DUO_BAR, duoSqueeze } from "../../lib/bottomBarSpan";
import { useScreenLayout } from "../../state/app/screenLayout";
import { t } from "../../lib/uiLanguage";


export const BrowsingScreen = memo(function BrowsingScreen({ tab }: { tab: BrowserTab }) {
  countRender(t(`BrowsingScreen`));
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
  const menuOpen = useMenuOpen();
  const menuDocked = useMenuDocked();
  const finding = useFindOpen();
  const readerId = useReaderTabId();
  const pressing = usePressOpen();
  const tone = usePageTone(tab.id);
  const order = useDeckOrder();
  const separatesIncognito = design !== "original";
  const barOrder = useMemo(() => (separatesIncognito ? order.filter((other) => other.isPrivate === tab.isPrivate) : order), [order, separatesIncognito, tab.isPrivate]);
  const frozen = useFrozenOrder();
  const searching = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const dockedSearch = design === "material" && menuDocked && searching && searchFromMenu;
  const [tabsMenu, setTabsMenu] = useState(false);
  const menu = usePresence(menuOpen || dockedSearch);
  useEffect(() => closePageMenu, [tab.id]);
  const byId = useMemo(() => new Map(order.map((t) => [t.id, t])), [order]);
  const around = useMemo(() => neighbours(separatesIncognito ? swipeOrder().filter((id) => byId.get(id)?.isPrivate === tab.isPrivate) : swipeOrder(), tab.id), [order, frozen, tab.id, byId, separatesIncognito, tab.isPrivate]);
  const left = around.left ? (byId.get(around.left) ?? null) : null;
  const right = around.right ? (byId.get(around.right) ?? null) : null;
  const handsOver = pageReportsDrawn();
  const pager = useTabPager({
    width,
    selectedId: tab.id,
    left: left?.id ?? null,
    right: right?.id ?? null,
    landsEarly: handsOver,
    onCommit: handsOver ? arriveAtNeighbour : swipeToNeighbour,
    onGrab: captureCurrentCover,
  });
  useDemoMotion(pager, width);
  const arrived = useBrowse((s) => s.arriving === tab.id && s.covered === tab.id);
  const failed = useNavigation(tab.id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const underBar = usePageUnderBars();
  const blankPage = underBar ? theme.pageSurface : theme.surface;
  const top = pageTone?.top ?? blankPage;
  const bottom = pageTone?.bottom ?? blankPage;
  const barDark = (design === "redesigned" || design === "material") && !pageTone?.bottom ? theme.dark : isDarkColor(bottom);
  useSystemBars(isDarkColor(top), barDark);
  const barSlotHeight = barHeight(insets.bottom, design);
  const collapse = useBarCollapse(tab.id, tab.isPrivate, finding, design, barSlotHeight, squeeze !== null);
  const duoBar = useMemo(() => (duoStrip ? { stripLeft: duoStrip.centerX - DUO_BAR.button / 2 - controlsSpan.left, stripTop: duoStrip.plus, squeeze, progress: collapse.fold.progress, collapsed: collapse.collapsed } : null), [duoStrip?.centerX, duoStrip?.plus, controlsSpan.left, squeeze?.marginLeft, squeeze?.marginRight, collapse.fold.progress, collapse.collapsed]);
  const folds = squeeze === null;
  const staged = design === "redesigned" && searchStageIsNative();
  useEffect(() => (staged && !collapse.hidden ? reportBarPill() : undefined), [staged, collapse.hidden]);
  const layout = underBar ? { pageBottom: 0, toneBottom: design === "material" ? 0 : barSlotHeight } : pageInsets(collapse.collapses, barSlotHeight, browseLayout.pageOverlap);
  const fullscreen = usePages((s) => s.fullscreen[tab.id] ?? false);
  const coveredBottom = design === "material" ? materialCoveredBottom(collapse.collapses, barSlotHeight, fullscreen || finding || searching) : obscuredBottom({ follows: Platform.OS === "android", bar: barSlotHeight, pill: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2 + hostPillLayout.height, collapsed: collapse.collapsed, cleared: fullscreen || finding || searching });
  const obscured = underBar ? { top: insets.top, bottom: coveredBottom } : undefined;
  const materialSummaryBottom = fullscreen || searching ? insets.bottom : collapse.collapsed ? insets.bottom + materialBottomBar.inset + materialBarPill.height : barSlotHeight;
  const summaryBottomInset = design === "material" ? materialSummaryBottom : undefined;
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
    if (pulls) labTrace(t(`PAGELAB bar swipe recognised with no pull to track`));
    void showDeck();
  };
  const pullBegan = () => deckPullBegan(tab.id);
  const pullReleased = (lands: boolean) => deckPullReleased(tab.id, lands);
  const barPull = tracks ? { id: tab.id, prepare: refreshHiddenDeck, began: pullBegan, released: pullReleased, settled: deckPullSettled } : null;
  const barGesture = useMemo(() => Gesture.Race(pager.gesture, barSwipeUp(swipesUp, pager.active, openDeckFromBar, barPull, pulls && reduceMotion)), [pager.gesture, swipesUp, incognito, tracks, tab.id]);
  const statusStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(top, { duration: tabsMotion.barTone }) : top }), [top]);
  const barStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(bottom, { duration: tabsMotion.barTone }) : bottom }), [bottom]);
  const { scheme: materialScheme } = useMaterialTheme(tab.isPrivate);
  const pageMenu = menu.mounted ? <PageMenu tabId={tab.id} open={menuOpen} onHidden={menu.hidden} /> : null;
  const siteSettingsSheet = design === "material" && menuDocked ? pageMenu : null;
  const barBlocked = collapse.hidden || siteSettingsSheet !== null;
  const materialBarFold = useMaterialBarFold(design === "material" ? collapse.fold.progress : null);
  const materialPillFold = useMaterialPillFold(design === "material" ? collapse.fold.progress : null);
  const materialBarHosted = useMaterialBarRegistration("page", design === "material" ? {
    bar: { isTabOverview: false, scheme: materialScheme, tab, order: barOrder, showsPlus: !searching, addressDocked: siteSettingsSheet !== null, onTabs: showDeck, onTabsMenu: openTabsMenu, onStep: stepTab, onAddress: editPageQuery, onPlus: newTab, onMore: openPageMenu, onSiteSettings: openDockedSiteSettings },
    gesture: barGesture,
    tabId: tab.id,
    hidden: finding || fullscreen || (menu.mounted && !siteSettingsSheet) || readerId === tab.id || pressing || tabsMenu,
    blocked: barBlocked,
    collapse: { progress: collapse.hide, travel: collapse.travel },
    fold: { progress: collapse.fold.progress, collapsed: collapse.collapsed, expand: collapse.expand },
    siteSettingsSheet,
  } : null);

  return (
    <View style={[StyleSheet.absoluteFill, pulls ? null : { backgroundColor: theme.surface }]} onLayout={() => pageLaidOut(tab.id)}>
      <Shade shaded={menuOpen || dockedSearch || readerId === tab.id || pressing || tabsMenu}>
        <PageStack pulledTab={pulls ? tab.id : null} barTop={barTop}>
        <PagerBackdrop />
        <Animated.View style={[StyleSheet.absoluteFill, styles.outgoing, { backgroundColor: theme.surface }, pager.outgoing]}>
          {underBar ? null : <Animated.View testID="pageStatusStrip" style={[{ height: insets.top }, statusStyle]} />}
          <View testID="pageArea" style={[styles.page, { marginBottom: layout.pageBottom }]}>
            <PageSurface key={tab.id} tab={tab} toneBottom={layout.toneBottom} obscured={obscured} bottomInsetTransitionMs={Platform.OS === "android" && collapse.collapses && design === "redesigned" && !fullscreen && !finding && !searching ? hostPillLayout.foldSettleMs : 0} summaryBottomInset={summaryBottomInset} pinsSafeArea={pulls ? true : undefined} />
            <PageCover key={`${tab.id}:cover`} tab={tab} />
            <PageFailureView key={`${tab.id}:failure`} tabId={tab.id} />
          </View>
          {underBar ? <Animated.View testID="pageStatusStrip" pointerEvents="none" style={[styles.statusOver, { height: insets.top }, statusStyle]} /> : null}
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: tabsInk.pagerBlack }, pager.dim]} pointerEvents="none" />
        </Animated.View>
        {pagerCards(left, right, arrived ? tab : null).map(({ card, side }) => (
          <PagerNeighbour key={card.id} pager={pager} tab={card} side={side} width={width} statusHeight={insets.top} statusOver={underBar} hasLeft={left !== null} hasRight={right !== null} coverId={ARRIVAL_COVER_ID} />
        ))}
        <View style={[styles.loading, { top: insets.top }]} pointerEvents="none">
          <PageLoadingLine tabId={tab.id} color={theme.accent} />
        </View>
        </PageStack>
        {materialBarHosted && design === "material" ? null : (
        <GestureDetector gesture={barGesture}>
          <Animated.View
            testID="pageBar"
            pointerEvents={barBlocked ? "none" : design === "redesigned" || design === "material" ? "box-none" : "auto"} collapsable={false}
            importantForAccessibility={barBlocked ? "no-hide-descendants" : "auto"}
            accessibilityElementsHidden={barBlocked}
            style={[styles.bar, { height: barHeight(insets.bottom, design) }, underBar ? null : barStyle, finding && design === "material" ? styles.replacedBar : collapse.style]}
          >
            {design === "redesigned" && underBar ? <BarBase color={bottom} controlTop={barCenterFromBottom(insets.bottom, design) + floatingBarLayout.control / 2} control={floatingBarLayout.control} fold={collapse.fold.progress} foldDrop={floatingBarLayout.control - hostPillLayout.height} /> : null}
            {design === "redesigned" ? (
              <Animated.View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2, ...controlsSpan }, pulls ? barShift : null]} pointerEvents="box-none">
                <Animated.View
                  testID="floatingBarFold"
                  collapsable={false}
                  renderToHardwareTextureAndroid={Platform.OS === "android"}
                  style={folds ? collapse.fold.bar : null}
                  pointerEvents={folds && collapse.collapsed ? "none" : "box-none"}
                  importantForAccessibility={folds && collapse.collapsed ? "no-hide-descendants" : "auto"}
                  accessibilityElementsHidden={folds && collapse.collapsed}
                >
                  <FloatingBar
                    tab={tab}
                    order={barOrder}
                    roles={rolesFor(barDark)}
                    dark={barDark}
                    showsPlus={staged || !searching}
                    anchors={!folds || !collapse.collapsed}
                    duo={duoBar}
                    onTabs={showDeck}
                    onTabsMenu={openTabsMenu}
                    onStep={stepTab}
                    onAddress={editPageQuery}
                    onPlus={newTab}
                    onMore={openPageMenu}
                  />
                </Animated.View>
                {folds && collapse.fold.pillMounted ? (
                  <Animated.View
                    testID="hostPillFold"
                    collapsable={false}
                    renderToHardwareTextureAndroid={Platform.OS === "android"}
                    style={[styles.pillPlace, collapse.fold.pill]}
                    pointerEvents={collapse.collapsed ? "box-none" : "none"}
                    importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"}
                    accessibilityElementsHidden={!collapse.collapsed}
                  >
                    <HostPill tab={tab} dark={barDark} shown={collapse.collapsed} anchors={collapse.collapsed} contentStyle={collapse.fold.pillContent} onExpand={collapse.expand} />
                  </Animated.View>
                ) : null}
              </Animated.View>
            ) : design === "material" ? (
              <>
                <Animated.View testID="materialBarFold" collapsable={false} style={[StyleSheet.absoluteFill, materialBarFold]} pointerEvents={collapse.collapsed ? "none" : "box-none"} importantForAccessibility={collapse.collapsed ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={collapse.collapsed}>
                  <MaterialBarBand tab={tab} order={barOrder} showsPlus={!searching} addressDocked={siteSettingsSheet !== null} safeSide={safeSide} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onAddress={editPageQuery} onPlus={newTab} onMore={openPageMenu} onSiteSettings={openDockedSiteSettings} />
                </Animated.View>
                <Animated.View testID="materialBarPillPlace" collapsable={false} style={[styles.materialPillPlace, { bottom: insets.bottom + materialBottomBar.inset - materialBarPill.shadowRoom, left: safeSide + materialBottomBar.edge, right: safeSide + materialBottomBar.edge }, materialPillFold]} pointerEvents={collapse.collapsed ? "box-none" : "none"} importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!collapse.collapsed}>
                  <MaterialBarPill tab={tab} scheme={materialScheme} onExpand={collapse.expand} />
                </Animated.View>
              </>
            ) : (
              <>
                <View style={[StyleSheet.absoluteFill, { backgroundColor: barDark ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} />
                <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - browseLayout.hitTarget / 2, ...controlsSpan }]}>
                  <BottomBar order={order} roles={rolesFor(barDark)} showsPlus={!searching} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onPlus={newTab} onMore={openPageMenu} />
                </View>
              </>
            )}
          </Animated.View>
        </GestureDetector>
        )}
        {finding && design !== "material" ? <FindBar tabId={tab.id} /> : null}
        {pulls ? <PullBlocker /> : null}
      </Shade>
      {finding && design === "material" ? <MaterialFindBar tabId={tab.id} /> : null}
      {tabsMenu ? (
        <Menu
          items={tabsMenuItems(barOrder)}
          place={duoStrip ? { bottom: barCenterFromBottom(insets.bottom, design) - DUO_BAR.button / 2, ...besideStrip(duoStrip, width, tabsLayout.menuWidth, space.l) } : { bottom: barHeight(insets.bottom, design) + space.xs, left: space.l, width: Math.min(tabsLayout.menuWidth, width - space.l * 2) }}
          frost={null}
          onDismiss={() => setTabsMenu(false)}
        />
      ) : null}
      <PressMenu width={width} height={height} />
      {materialBarHosted && siteSettingsSheet ? null : pageMenu}
      {readerId === tab.id ? <ReaderView tabId={tab.id} /> : null}
      <PageRequestHost tabId={tab.id} />
      {Platform.OS === "android" ? <TabSwipeHint pager={pager} toward={right ? 1 : left ? -1 : 0} tabId={tab.id} calm={!searching && !menuOpen && !finding && !tabsMenu && !fullscreen && readerId !== tab.id && !collapse.hidden && !pressing} /> : null}
    </View>
  );
});


function pagerCards(left: BrowserTab | null, right: BrowserTab | null, arrival: BrowserTab | null): { card: BrowserTab; side: -1 | 0 | 1 }[] {
  const cards: { card: BrowserTab; side: -1 | 0 | 1 }[] = [];
  if (left) cards.push({ card: left, side: -1 });
  if (right) cards.push({ card: right, side: 1 });
  if (arrival) cards.push({ card: arrival, side: 0 });
  return cards;
}

function PageStack({ pulledTab, barTop, children }: { pulledTab: string | null; barTop: number; children: ReactNode }) {
  if (pulledTab) return <PagePull tabId={pulledTab} barTop={barTop}>{children}</PagePull>;
  return children;
}

const materialCoveredBottom = (folds: boolean, bar: number, cleared: boolean) => (folds || cleared ? 0 : bar);

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
  const followed = android ? followScroll(state, tabId, page, direction, followsScroll) : state;
  if (followed !== state) setState(followed);
  useEffect(() => {
    if (!android) setState((now) => followScroll(now, tabId, page, direction, followsScroll));
  }, [tabId, page, direction, followsScroll]);
  const scrolledAway = followed.hidden && followed.tabId === tabId;
  const collapsed = folds && scrolledAway && !finding;
  const hidden = finding || (!folds && scrolledAway);
  const slidesAway = hidden && !materialFind;
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if ((android || squeezes) && collapsed && !wasCollapsed.current && !isPrivate) countUsage("bottom_bar_collapses");
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
  return [...others, ...(others.length ? ["divider" as const] : []), { label: t(`Close Tab`), icon: "xmark", destructive: true, onPress: closeFrontTab }];
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
  statusOver: { position: "absolute", left: 0, right: 0, top: 0 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  replacedBar: { opacity: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
  materialPillPlace: { position: "absolute", height: materialBarPill.height + materialBarPill.shadowRoom * 2, paddingVertical: materialBarPill.shadowRoom, alignItems: "center", justifyContent: "flex-end" },
  pillPlace: { position: "absolute", left: 0, right: 0, bottom: 0, height: hostPillLayout.height, alignItems: "center", justifyContent: "flex-end" },
});
