import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScreenLayout, type ScreenFold } from "../../state/app/screenLayout";
import { useSystemBars } from "../../state/app/systemBars";
import { useSurface, watchPageLoad } from "../../state/browse/hooks";
import { consumeDeckEntrance, deckEntered, leaveDeck, pageLaidOut, useBrowse } from "../../state/browse/store";
import { closePageMenu } from "../../state/page/actions";
import { useFindOpen, useMenuOpen, useReaderTabId } from "../../state/page/hooks";
import { useSearchOpen } from "../../state/search/hooks";
import { useIncognito, useSelectedTab } from "../../state/tabs/hooks";
import { currentTabs } from "../../state/tabs/store";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { LoadingLine, LookBackdrop, tabsCurve, usePresence, useReduceMotion, useTheme, type LoadWatch } from "../ui";
import { FindBar } from "../browsing/FindBar";
import { PageCover } from "../browsing/PageCover";
import { PageFailureView } from "../browsing/PageFailureView";
import { PageSurface } from "../browsing/PageSurface";
import { PageMenu } from "../browsing/PageMenu";
import { PageRequestHost, PressMenu } from "../browsing/PageRequests";
import { ReaderView } from "../browsing/ReaderView";
import { DuoSidebar } from "./DuoSidebar";
import { DuoToolbar } from "./DuoToolbar";
import { DUO, sidebarFrame, splitCardFrame, splitPanelFrame, toolbarFrame, wideCardFrame, type DuoFrame } from "./duoLayout";
import { duoInk, duoMotion } from "./tokens";

export function DuoBrowsing() {
  const layout = useScreenLayout((s) => s.layout);
  const fold = layout.name === "split" ? layout.fold : null;
  const window = useWindowDimensions();
  const canvas = useScreenLayout((s) => s.canvas);
  const { width, height } = canvas ?? window;
  const insets = useSafeAreaInsets();
  const surface = useSurface();
  const tab = useSelectedTab();
  const searching = useSearchOpen();
  const incognito = useIncognito();
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  useSystemBars(theme.dark || incognito);
  const sidebar = useSidebar(reduceMotion);
  const { show } = sidebar;
  useEffect(() => {
    if (surface !== "deck") return;
    if (tab) {
      consumeDeckEntrance();
      deckEntered(tab.id);
      leaveDeck();
    }
    if (!fold) show(true);
  }, [surface, tab?.id]);
  useEffect(() => {
    if (searching) show(false);
  }, [searching]);
  const folded = fold !== null;
  const wasFolded = useRef(folded);
  useEffect(() => {
    if (wasFolded.current === folded) return;
    wasFolded.current = folded;
    show(false);
  }, [folded]);
  const card = fold ? splitCardFrame(width, insets, fold) : wideCardFrame(width, height, insets);
  const toolbar = toolbarFrame(card);
  const shownTab = tab && surface !== "start" ? tab : null;
  return (
    <View testID="duoBrowsing" style={StyleSheet.absoluteFill}>
      <LookBackdrop themed={!incognito} incognito={incognito} />
      <PageCard card={card} tab={shownTab} front={surface === "browsing" && !sidebar.shown} />
      <View testID="duoToolbarPlace" pointerEvents="box-none" style={[styles.place, frameStyle(toolbar)]}>
        <DuoToolbar showsAddress={!fold} sidebarShown={sidebar.shown} sidebar={sidebar.progress} onToggleSidebar={() => show(!sidebar.shown)} />
      </View>
      {fold ? <SplitPanel width={width} height={height} fold={fold} safeBottom={insets.bottom} /> : <SidebarOverlay sidebar={sidebar} frame={sidebarFrame(width, height, insets)} reduceMotion={reduceMotion} />}
      {shownTab ? <PageOverlays tab={shownTab} width={width} height={height} /> : null}
    </View>
  );
}

type Sidebar = ReturnType<typeof useSidebar>;

function useSidebar(reduceMotion: boolean) {
  const [shown, setShown] = useState(false);
  const [mounted, setMounted] = useState(false);
  const progress = useSharedValue(0);
  if (shown && !mounted) setMounted(true);
  const gone = useCallback(() => setMounted(false), []);
  useEffect(() => {
    const target = shown ? 1 : 0;
    const settled = (finished?: boolean) => {
      "worklet";
      if (finished && target === 0) runOnJS(gone)();
    };
    progress.value = reduceMotion ? withTiming(target, { duration: duoMotion.reducedFade, easing: tabsCurve.easeOut }, settled) : withSpring(target, duoMotion.slide, settled);
  }, [shown, reduceMotion]);
  const show = useCallback((next: boolean) => {
    if (!next && useBrowse.getState().surface === "deck" && currentTabs().selectedId === null) leaveDeck();
    setShown(next);
  }, []);
  return { shown, mounted: shown || mounted, progress, show };
}

function SidebarOverlay({ sidebar, frame, reduceMotion }: { sidebar: Sidebar; frame: DuoFrame; reduceMotion: boolean }) {
  const travel = frame.x + frame.width;
  const dimStyle = useAnimatedStyle(() => ({ opacity: sidebar.progress.value }));
  const slideStyle = useAnimatedStyle(() => ({ opacity: sidebar.progress.value, transform: [{ translateX: reduceMotion ? 0 : -travel * (1 - sidebar.progress.value) }] }), [travel, reduceMotion]);
  if (!sidebar.mounted) return null;
  const hide = () => sidebar.show(false);
  return (
    <>
      <Animated.View testID="duoDim" collapsable={false} style={[StyleSheet.absoluteFill, dimStyle]} pointerEvents={sidebar.shown ? "auto" : "none"} importantForAccessibility={sidebar.shown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!sidebar.shown}>
        <Pressable accessibilityRole="button" accessibilityLabel="Hide Sidebar" onPress={hide} style={[StyleSheet.absoluteFill, { backgroundColor: duoInk.pageDim }]} />
      </Animated.View>
      <Animated.View
        testID="duoSidebarPlace"
        collapsable={false}
        pointerEvents={sidebar.shown ? "box-none" : "none"}
        importantForAccessibility={sidebar.shown ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!sidebar.shown}
        style={[styles.place, frameStyle(frame), slideStyle]}
      >
        <DuoSidebar variant="overlay" onClose={hide} />
      </Animated.View>
    </>
  );
}

function SplitPanel({ width, height, fold, safeBottom }: { width: number; height: number; fold: ScreenFold; safeBottom: number }) {
  const panel = splitPanelFrame(width, height, { top: 0, left: 0, right: 0, bottom: safeBottom }, fold);
  return (
    <View testID="duoPanelPlace" style={[styles.place, frameStyle(panel), { paddingBottom: panel.paddingBottom }]}>
      <DuoSidebar variant="panel" onClose={noop} />
    </View>
  );
}

const noop = () => undefined;

function PageCard({ card, tab, front }: { card: DuoFrame; tab: BrowserTab | null; front: boolean }) {
  const theme = useTheme();
  return (
    <View testID="duoCard" style={[styles.place, styles.card, frameStyle(card)]} importantForAccessibility={front ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!front}>
      <View style={[styles.cardClip, { backgroundColor: tab ? theme.surface : undefined }]} onLayout={tab ? () => pageLaidOut(tab.id) : undefined}>
        {tab ? (
          <>
            <PageSurface key={tab.id} tab={tab} toneBottom={0} obscured={NO_INSETS} topClearance={DUO.toolbarClearance} testID="duoPage" />
            <PageCover key={`${tab.id}:cover`} tab={tab} />
            <PageFailureView key={`${tab.id}:failure`} tabId={tab.id} />
            <View style={styles.loading} pointerEvents="none">
              <DuoLoadingLine tabId={tab.id} color={theme.accent} />
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

const NO_INSETS = { top: 0, bottom: 0 } as const;

function DuoLoadingLine({ tabId, color }: { tabId: string; color: string }) {
  const watch = useMemo<LoadWatch>(() => (show) => watchPageLoad(tabId, show), [tabId]);
  return <LoadingLine watch={watch} color={color} />;
}

function PageOverlays({ tab, width, height }: { tab: BrowserTab; width: number; height: number }) {
  const menuOpen = useMenuOpen();
  const finding = useFindOpen();
  const readerId = useReaderTabId();
  const menu = usePresence(menuOpen);
  useEffect(() => closePageMenu, [tab.id]);
  return (
    <>
      {finding ? <FindBar tabId={tab.id} /> : null}
      <PressMenu width={width} height={height} />
      {menu.mounted ? <PageMenu tabId={tab.id} open={menuOpen} onHidden={menu.hidden} /> : null}
      {readerId === tab.id ? <ReaderView tabId={tab.id} /> : null}
      <PageRequestHost tabId={tab.id} />
    </>
  );
}

const frameStyle = (frame: DuoFrame) => ({ left: frame.x, top: frame.y, width: frame.width, height: frame.height });

const styles = StyleSheet.create({
  place: { position: "absolute" },
  card: { borderRadius: DUO.cardRadius, borderCurve: "continuous", boxShadow: duoInk.cardShadow },
  cardClip: { flex: 1, borderRadius: DUO.cardRadius, borderCurve: "continuous", overflow: "hidden" },
  loading: { position: "absolute", top: 0, left: 0, right: 0 },
});
