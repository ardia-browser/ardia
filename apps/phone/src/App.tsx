import { startTransition, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { FrameProbe } from "./components/perf/FrameProbe";
import { countRender, interactionPerfEnabled } from "./state/app/interactionPerf";
import { AppState, BackHandler, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BrowsingScreen } from "./components/browsing/BrowsingScreen";
import { MaterialBarProvider, PersistentMaterialBar } from "./components/browsing/PersistentMaterialBar";
import { SearchTray } from "./components/search/SearchTray";
import { StartScreen } from "./components/search/StartScreen";
import { ArchiveView } from "./components/tabs/ArchiveView";
import { TabDeck } from "./components/tabs/TabDeck";
import { OnboardingView } from "./components/onboarding/OnboardingView";
import { ImportFailedView } from "./components/upgrade/ImportFailedView";
import { ExpoSettingsSheet } from "./components/settings/ExpoSettingsStack";
import { ExpoArchiveSheet } from "./components/tabs/ExpoArchive";
import { ExpoSpacesSheet } from "./components/sync/ExpoSpaces";
import { ExpoLibrarySheet } from "./components/library/ExpoLibrary";
import { MaterialLibrary } from "./components/library/MaterialLibrary";
import { LibraryView } from "./components/library/LibraryView";
import { closeLibrary, useLibrary } from "./state/library/store";
import { SettingsView } from "./components/settings/SettingsView";
import { SpacesView } from "./components/sync/SpacesView";
import { ToastHost } from "./components/toasts/ToastHost";
import { followDesign, tabsMotion, useDesign, useTheme, DEFAULT_PROFILE_COLOR, FrostSource, FullSheet, OverlayHost, PROFILE_PRESETS, onDrawnMenuOpened, onNativeMenuOpened, ProfileLookContext, Shade, SheetBackground, SURFACES_FROST } from "./components/ui";
import { useLook } from "./state/sync/hooks";
import { startSettingsSources } from "./state/settings/actions";
import { startSync } from "./state/sync/actions";
import { setSpacesDesign } from "./state/sync/store";
import { setAppearanceDesign, useDarkScheme } from "./state/settings/appearance";
import { useSettingsNav } from "./state/settings/hooks";
import { offerBrowseForMePage, offerPageSummaryPage, offerSyncPages } from "./state/settings/nav";
import { useOnboarding } from "./state/onboarding/hooks";
import { bootApp, useBoot } from "./state/app/boot";
import { startLinks } from "./state/links/links";
import { useBaseSystemBars, useSystemBars } from "./state/app/systemBars";
import { useSearchFromDockedMenu, useSearchOpen } from "./state/search/hooks";
import { useLeavingTab, useOpeningTab, useSheet, useSurface } from "./state/browse/hooks";
import { appBecameActive, appWillResignActive, closeArchive, deckPullInFlight, goBackToStartIfEmpty, keepFrontPictureCurrent, startBrowser, type Surface } from "./state/browse/store";
import { refreshHiddenDeck, resizeRoot } from "./state/browse/deckHold";
import { useDeckStandbyWanted } from "./state/browse/deckStandby";
import { deckPullGrowing } from "./state/browse/deckPull";
import { noteScreenLayout, noteWindowShape } from "./state/app/landscapeCount";
import { DUO_CANVAS, reportScreenLayout, useScreenLayout } from "./state/app/screenLayout";
import { DuoBrowsing } from "./components/duo/DuoBrowsing";
import { ScreenLayoutProbe } from "@ardia/phone-native";
import { handleSystemBack, startPageUi } from "./state/page/actions";
import { VoiceSearchView } from "./components/search/VoiceSearchView";
import { useVoicePresented } from "./state/voice/store";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { closeSettings } from "./state/settings/nav";
import { applyLaunchSettings, runLaunchScenario } from "./state/app/launch";
import { frontSheet } from "./state/settings/settingsRules";
import { inkLayer, lightStatusIcons } from "./lib/statusInk";
import { whenIdle } from "./lib/whenIdle";
import { countUsage, reportLaunch, startTelemetry } from "./state/telemetry/telemetry";
import { useIncognito, useSelectedTab } from "./state/tabs/hooks";
import { syncOffered } from "./state/sync/offer";
import { countDrawnMenu, countNativeMenu } from "./state/browse/menuCounts";
import { browseForMeOffered } from "./state/browseForMe/offer";
import { pageSummaryChoiceOffered } from "./state/pageSummary/store";
import { listenForBrowseForMe } from "./state/browseForMe/events";
import { followDynamicScheme } from "./state/app/dynamicScheme";
import { useMaterialTheme } from "./components/ui/materialTheme";
import type { Design } from "./lib/design";
import { onMaterialBackSwiped } from "./components/ui/MaterialSurfaces";
import { useTabs } from "./state/tabs/store";

export default function App() {
  useState(() =>
    bootApp(() => {
      offerSyncPages(syncOffered);
      offerBrowseForMePage(browseForMeOffered);
      offerPageSummaryPage(pageSummaryChoiceOffered);
      followDesign(applyDesign);
      startTelemetry();
      startBrowser(applyLaunchSettings);
      startPageUi();
      startSettingsSources();
      if (syncOffered()) startSync();
      startLinks();
      listenForBrowseForMe();
      runLaunchScenario();
    }),
  );
  const ready = useBoot((s) => s.ready);
  const importFailed = useBoot((s) => s.failures > 0);
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => void reportLaunch(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  const dark = useDarkScheme();
  const look = useLook(PROFILE_PRESETS, DEFAULT_PROFILE_COLOR);
  useBaseSystemBars(dark);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => useBoot.getState().ready && handleSystemBack());
    const state = AppState.addEventListener("change", (next) => {
      if (!useBoot.getState().ready) return;
      if (next === "active") appBecameActive();
      else appWillResignActive();
    });
    return () => {
      back.remove();
      state.remove();
    };
  }, []);
  return (
    <GestureHandlerRootView style={styles.root} onLayout={(event) => resizeRoot(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}>
      <SafeAreaProvider>
        <ScreenLayoutProbe onLayoutChange={reportScreenLayout} />
        <ProfileLookContext.Provider value={look}>
          <OverlayHost>{ready ? <DuoCanvasFrame><Surfaces /></DuoCanvasFrame> : importFailed ? <ImportFailedView /> : null}</OverlayHost>
          {interactionPerfEnabled() ? <FrameProbe /> : null}
        </ProfileLookContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const SYSTEM_SHEETS = Platform.OS === "ios";

function applyDesign(design: Design) {
  setSpacesDesign(design);
  setAppearanceDesign(design);
  if (design === "material") followDynamicScheme();
}

onNativeMenuOpened(countNativeMenu);
onDrawnMenuOpened(countDrawnMenu);

onMaterialBackSwiped(() => {
  if (!useTabs.getState().incognito) countUsage("material_back_swiped");
});

export function Surfaces() {
  const surface = useSurface();
  const sheet = useSheet();
  const tab = useSelectedTab();
  const opening = useOpeningTab();
  const leaving = useLeavingTab();
  const design = useDesign();
  const pageOverDeck = design === "redesigned";
  const pageUnderDeck = surface === "deck" && tab !== null && (tab.id === opening || tab.id === leaving);
  const settingsOpen = useSettingsNav((s) => s.open);
  const onboarding = useOnboarding((s) => s.showing);
  const searching = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const voice = useVoicePresented();
  const sheetProgress = useSharedValue(0);
  const libraryOpen = useLibrary((s) => s.open);
  const material = design === "material";
  const libraryCovers = material && libraryOpen;
  const systemSheet = SYSTEM_SHEETS && (settingsOpen || libraryOpen || sheet === "archive" || sheet === "spaces");
  const front = frontSheet(settingsOpen && !SYSTEM_SHEETS, SYSTEM_SHEETS && (sheet === "archive" || sheet === "spaces") ? null : sheet, libraryOpen && !SYSTEM_SHEETS && !libraryCovers);
  const sheetCovers = front !== null || systemSheet;
  const theme = useTheme();
  countRender("Surfaces");
  const incognito = useIncognito();
  const layer = inkLayer({ onboarding, voice, sheet: sheetCovers, searching: searching || libraryCovers, surface });
  const incognitoScheme = useMaterialTheme(true).scheme;
  const behind = material && incognito ? incognitoScheme.surface : theme.backdrop[0];
  const lightIcons = lightStatusIcons(layer, { cover: behind, surface: front === "settings" ? behind : theme.canvas, deck: behind, incognito: incognito && !libraryCovers });
  useEffect(goBackToStartIfEmpty, [tab, surface]);
  const duo = useScreenLayout((s) => s.layout.name === "wide" || s.layout.name === "split");
  const deckMounted = useDeckStandby(surface, surface === "browsing" && tab !== null && opening === null && leaving === null && !searching && !voice && !onboarding && front === null, tab?.id ?? null);
  const page = !duo && (surface === "browsing" || pageUnderDeck) && tab ? <BrowsingScreen tab={tab} /> : null;
  const deck = !duo && deckMounted ? <TabDeck key="deck" /> : null;
  const pageLayer = page && tab ? (
    <PageLayer key="page" away={surface === "deck"} unseen={pageOverDeck && surface === "deck" && tab.id === opening && deckPullGrowing() !== tab.id}>
      {page}
    </PageLayer>
  ) : null;
  return (
    <MaterialBarProvider enabled={material && !duo}>
      <LandscapeCount />
      <SheetBackground progress={sheetProgress}>
        <Layer covered={onboarding || voice} muted={sheetCovers || libraryCovers}>
          <Shade shaded={searching && !(material && searchFromMenu)}>
            <FrostSource name={SURFACES_FROST} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
              {duo && surface !== "start" ? <DuoBrowsing /> : null}
              {pageOverDeck ? [deck, pageLayer] : [pageLayer, deck]}
              {surface === "start" ? <StartScreen /> : null}
              {material ? <PersistentMaterialBar /> : null}
            </FrostSource>
          </Shade>
          <SearchTray />
        </Layer>
      </SheetBackground>
      <Layer covered={onboarding || voice}>
        <FullSheet sheet={front} progress={sheetProgress} onDismiss={front === "settings" ? closeSettings : front === "library" ? closeLibrary : closeArchive}>
          {(shown) => (shown === "settings" ? <SettingsView /> : shown === "library" ? <LibraryView /> : shown === "archive" ? <ArchiveView /> : <SpacesView />)}
        </FullSheet>
      </Layer>
      {SYSTEM_SHEETS ? <ExpoSettingsSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoArchiveSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoSpacesSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoLibrarySheet /> : null}
      {material ? <MaterialLibrary /> : null}
      <Layer covered={onboarding}>
        <VoiceSearchView />
      </Layer>
      <OnboardingView />
      <ToastHost />
      {lightIcons !== null ? <LayerInk key={layer} light={lightIcons} /> : null}
    </MaterialBarProvider>
  );
}

const PAGE_UNSEEN_AWAY = 100_000;

function PageLayer({ away, unseen, children }: { away: boolean; unseen: boolean; children: ReactNode }) {
  return (
    <View
      testID="pageLayer"
      style={[StyleSheet.absoluteFill, unseen ? styles.unseen : null]}
      pointerEvents={away ? "none" : "box-none"}
      collapsable={false}
      importantForAccessibility={unseen || away ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={unseen || away}
    >
      {children}
    </View>
  );
}

function DuoCanvasFrame({ children }: { children: ReactNode }) {
  const canvas = useScreenLayout((s) => s.canvas);
  if (!canvas) return <>{children}</>;
  return (
    <View testID="duoCanvas" style={styles.canvasBack}>
      <View style={[styles.canvas, { width: canvas.width, height: canvas.height }]}>{children}</View>
    </View>
  );
}

function LandscapeCount() {
  const { width, height } = useWindowDimensions();
  const layout = useScreenLayout((s) => s.layout.name);
  const hinge = useScreenLayout((s) => s.hinge);
  useEffect(() => noteWindowShape(width, height), [width, height]);
  useEffect(() => noteScreenLayout(layout, hinge), [layout, hinge]);
  return null;
}

function useDeckStandby(surface: Surface, pageSettled: boolean, pageId: string | null) {
  const [standby, setStandby] = useState(false);
  if (surface === "deck" && !standby) setStandby(true);
  if (surface === "start" && standby) setStandby(false);
  const wanted = useDeckStandbyWanted();
  const [answered, setAnswered] = useState(wanted);
  if (answered !== wanted) {
    setAnswered(wanted);
    if (surface === "browsing" && !standby) setStandby(true);
  }
  useEffect(() => {
    if (!pageSettled) return;
    return whenIdle(() => {
      keepFrontPictureCurrent();
      if (!standby) startTransition(() => setStandby(true));
      else if (!deckPullInFlight()) refreshHiddenDeck();
    }, tabsMotion.deckStandby, tabsMotion.deckStandbyIdle);
  }, [pageSettled, pageId, standby]);
  return surface !== "start" && (standby || surface === "deck");
}

function LayerInk({ light }: { light: boolean }) {
  useSystemBars(light);
  return null;
}

const COVER_SETTLE_MS = 450;

function Layer({ covered, muted = false, children }: { covered: boolean; muted?: boolean; children: ReactNode }) {
  const [gone, setGone] = useState(covered);
  useEffect(() => {
    if (!covered) {
      setGone(false);
      return;
    }
    const settle = setTimeout(() => setGone(true), COVER_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [covered]);
  return (
    <View
      style={[StyleSheet.absoluteFill, gone ? styles.gone : null]}
      pointerEvents={covered || muted ? "none" : "box-none"}
      collapsable={false}
      importantForAccessibility={covered || muted ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={covered || muted}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  gone: { display: "none" },
  unseen: { transform: [{ translateX: PAGE_UNSEEN_AWAY }] },
  canvasBack: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000000", alignItems: "center", justifyContent: "center" },
  canvas: { borderRadius: DUO_CANVAS.radius, borderCurve: "continuous", overflow: "hidden" },
});
