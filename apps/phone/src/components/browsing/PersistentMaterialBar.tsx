import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { haptics } from "../../state/app/haptics";
import { useSurface } from "../../state/browse/hooks";
import { useSearchOpen } from "../../state/search/hooks";
import { useSelectedTab } from "../../state/tabs/hooks";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import type { MaterialScheme } from "../../lib/material/schemes";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { Favicon, Symbol, useReduceMotion } from "../ui";
import { MaterialBottomBar, type MaterialBottomBarProps } from "../ui/MaterialBottomBar";
import { barAddress, spokenAddress } from "./FloatingBar";
import { NotSecureLock } from "./NotSecureLock";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBarPill, materialBottomBar, materialShape, materialType } from "../ui/materialTokens";
import { t } from "../../lib/uiLanguage";


type BarCollapse = {
  progress: SharedValue<number>;
  travel: number;
};

type BarFold = {
  progress: SharedValue<number>;
  collapsed: boolean;
  expand: () => void;
};

type Registration = {
  bar: MaterialBottomBarProps;
  gesture?: ReturnType<typeof Gesture.Race>;
  hidden?: boolean;
  blocked?: boolean;
  collapse?: BarCollapse;
  fold?: BarFold;
  siteSettingsSheet?: ReactNode;
  tabId?: string;
  measure?: () => void;
};
type Entry = Registration & { owner: object };
type Slots = { page: Entry | null; deck: Entry | null; start: Entry | null };
const makeStore = () => createStore<Slots & { searchVisible: boolean }>(() => ({ page: null, deck: null, start: null, searchVisible: false }));
const BarContext = createContext<{ enabled: boolean; store: ReturnType<typeof makeStore> } | null>(null);
const noop = () => undefined;

export function MaterialBarProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [store] = useState(makeStore);
  const context = useMemo(() => ({ enabled, store }), [enabled, store]);
  return <BarContext.Provider value={context}>{children}</BarContext.Provider>;
}

export const useMaterialBarHosted = () => useContext(BarContext)?.enabled ?? false;

export function useMaterialSearchBarVisible() {
  const store = useContext(BarContext)?.store;
  useLayoutEffect(() => {
    store?.setState({ searchVisible: true });
    return () => { store?.setState({ searchVisible: false }); };
  }, [store]);
}

export function useMaterialBarRegistration(slot: keyof Slots, registration: Registration | null) {
  const context = useContext(BarContext);
  const owner = useRef({}).current;
  const store = context?.store;
  const enabled = context?.enabled ?? false;
  useLayoutEffect(() => {
    if (!store) return;
    if (enabled && registration) store.setState({ [slot]: { ...registration, owner } });
    else if (store.getState()[slot]?.owner === owner) store.setState({ [slot]: null });
  });
  useLayoutEffect(() => () => {
    if (store?.getState()[slot]?.owner === owner) store.setState({ [slot]: null });
  }, [store, slot, owner, enabled]);
  return enabled;
}

export function PersistentMaterialBar() {
  const context = useContext(BarContext);
  if (!context) return null;
  return <MaterialBarHost store={context.store} enabled={context.enabled} />;
}

function MaterialBarHost({ store, enabled }: { store: ReturnType<typeof makeStore>; enabled: boolean }) {
  const page = useStore(store, (state) => state.page);
  const deck = useStore(store, (state) => state.deck);
  const start = useStore(store, (state) => state.start);
  const searchVisible = useStore(store, (state) => state.searchVisible);
  const surface = useSurface();
  const tab = useSelectedTab();
  const searching = useSearchOpen();
  const insets = useSafeAreaInsets();
  const { scheme } = useMaterialTheme();
  const input = useRef<TextInputInstance>(null);
  const inertGesture = useMemo(() => Gesture.Pan().enabled(false).onStart(() => { "worklet"; }), []);
  const isTabOverview = surface === "deck";
  const isStart = surface === "start";
  const entry = isTabOverview ? deck : isStart ? start : page;
  const matches = isTabOverview || isStart || entry?.tabId === tab?.id;
  const searchPresented = searching || searchVisible;
  const pageSearch = !isTabOverview && !isStart && searchPresented;
  const hidden = !enabled || !entry || !matches || (searchPresented && !pageSearch) || entry.hidden;
  const fold = !isTabOverview && !isStart && !searchPresented ? entry?.fold ?? null : null;
  const folded = Boolean(fold?.collapsed);
  const blocked = hidden || searchPresented || entry?.blocked || folded;
  const foldProgress = fold?.progress ?? null;
  const shrink = useMaterialFoldShrink();
  const collapseProgress = entry?.collapse?.progress ?? null;
  const collapseTravel = entry?.collapse?.travel ?? 0;
  const hiddenValue = useSharedValue(0);
  const collapseActive = useSharedValue(0);
  const travelValue = useSharedValue(0);
  const collapseRevision = useSharedValue(0);
  const foldActive = useSharedValue(0);
  useLayoutEffect(() => {
    foldActive.value = foldProgress ? 1 : 0;
    hiddenValue.value = hidden ? 1 : 0;
    collapseActive.value = collapseProgress ? 1 : 0;
    travelValue.value = collapseTravel;
  }, [hidden, collapseProgress, collapseTravel, foldProgress, hiddenValue, collapseActive, travelValue, foldActive]);
  const motionStyle = useAnimatedStyle(() => {
    if (hiddenValue.value || collapseRevision.value < 0) return { opacity: 0, transform: [{ translateY: 0 }] };
    const progress = collapseActive.value && collapseProgress ? collapseProgress.value : 0;
    const folding = foldActive.value && foldProgress ? foldProgress.value : 0;
    const scale = 1 + (shrink - 1) * folding;
    return { opacity: (1 - progress) * (1 - folding), transform: [{ translateY: progress * travelValue.value + (materialBottomBar.height / 2) * (1 - scale) }, { scale }] };
  }, [collapseProgress, foldProgress, shrink]);
  const pillStyle = useMaterialPillFold(foldProgress);
  useEffect(() => {
    collapseRevision.value += 1;
  }, [collapseProgress, foldProgress, collapseRevision]);
  const fallback: MaterialBottomBarProps = { isTabOverview: true, scheme, search: { input, text: "", focused: false, change: noop, focus: noop, blur: noop }, incognito: false, canReopen: false, menusShown: false, onMenu: noop };
  const registeredBar = entry?.bar ?? fallback;
  const bar = pageSearch && !registeredBar.isStart && !registeredBar.isTabOverview
    ? { ...registeredBar, addressDocked: true, showsPlus: true }
    : registeredBar;
  const container = bar.container;
  useLayoutEffect(() => {
    if (!enabled || !isTabOverview || hidden) noteDeckBarTop(null);
  }, [enabled, isTabOverview, hidden]);
  useLayoutEffect(() => {
    if (!enabled || !isTabOverview || hidden || !entry?.measure) return;
    const measure = entry.measure;
    watchDeckBar(measure);
    measure();
    return () => watchDeckBar(null);
  }, [enabled, isTabOverview, hidden, entry?.measure]);
  const barStyles = [
    styles.place,
    { bottom: insets.bottom + materialBottomBar.inset, left: Math.max(insets.left, insets.right) + materialBottomBar.edge, right: Math.max(insets.left, insets.right) + materialBottomBar.edge },
    ...(container?.style ? [container.style] : []),
    motionStyle,
    ...(hidden ? [styles.hidden] : []),
  ];
  return (
    <>
      <GestureDetector gesture={!blocked && !isTabOverview && !isStart && entry?.gesture ? entry.gesture : inertGesture}>
        <MaterialBottomBar
          {...bar}
          container={{
            ...container,
            testID: "materialBottomBar",
            pointerEvents: blocked ? "none" : "auto",
            importantForAccessibility: blocked ? "no-hide-descendants" : "auto",
            accessibilityElementsHidden: Boolean(blocked),
            style: barStyles,
          }}
        />
      </GestureDetector>
      {fold && !hidden && bar.isTabOverview === false && !bar.isStart ? (
        <Animated.View
          testID="materialBarPillPlace"
          collapsable={false}
          pointerEvents={folded ? "box-none" : "none"}
          importantForAccessibility={folded ? "auto" : "no-hide-descendants"}
          accessibilityElementsHidden={!folded}
          style={[styles.pillPlace, { bottom: insets.bottom + materialBottomBar.inset - materialBarPill.shadowRoom, left: Math.max(insets.left, insets.right) + materialBottomBar.edge, right: Math.max(insets.left, insets.right) + materialBottomBar.edge }, pillStyle]}
        >
          <MaterialBarPill tab={bar.tab} scheme={scheme} onExpand={fold.expand} />
        </Animated.View>
      ) : null}
      {enabled && surface === "browsing" && matches && page?.siteSettingsSheet ? (
        <View testID="siteSettingsLayer" pointerEvents="box-none" style={styles.siteSettingsLayer}>
          {page.siteSettingsSheet}
        </View>
      ) : null}
    </>
  );
}

export function useMaterialFoldShrink() {
  return useReduceMotion() ? 1 : materialBarPill.collapsedScale;
}

export function useMaterialBarFold(progress: SharedValue<number> | null) {
  const shrink = useMaterialFoldShrink();
  return useAnimatedStyle(() => {
    const folding = progress ? progress.value : 0;
    const scale = 1 + (shrink - 1) * folding;
    return { opacity: 1 - folding, transform: [{ translateY: (materialBottomBar.height / 2) * (1 - scale) }, { scale }] };
  }, [progress, shrink]);
}

export function useMaterialPillFold(progress: SharedValue<number> | null) {
  const shrink = useMaterialFoldShrink();
  return useAnimatedStyle(() => {
    const folding = progress ? progress.value : 0;
    const scale = 1 / shrink + (1 - 1 / shrink) * folding;
    return { opacity: folding, transform: [{ translateY: (materialBarPill.height / 2) * (1 - scale) }, { scale }] };
  }, [progress, shrink]);
}

export function MaterialBarPill({ tab, scheme, onExpand }: { tab: BrowserTab; scheme: MaterialScheme; onExpand: () => void }) {
  const address = barAddress(tab);
  return (
    <Pressable
      testID="materialBarPill"
      accessibilityRole="button"
      accessibilityLabel={t(`Show Toolbar`)}
      accessibilityValue={{ text: spokenAddress(address) }}
      android_ripple={{ color: scheme.onSurface, borderless: false, foreground: true }}
      onPressIn={haptics.barPress}
      onPress={onExpand}
      style={[styles.pill, { backgroundColor: scheme.surfaceContainer }]}
    >
      {address.isPrivate ? (
        <Symbol name="eyes" size={materialBarPill.siteIcon} color={scheme.onSurfaceVariant} />
      ) : address.insecure ? (
        <NotSecureLock testID="materialBarPillNotSecure" size={materialBarPill.siteIcon} color={scheme.error} />
      ) : address.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={materialBarPill.siteIcon} />
      ) : null}
      <Text testID="materialBarPillHost" numberOfLines={1} ellipsizeMode="middle" style={[materialType.labelLarge, styles.pillHost, { color: scheme.onSurface }]}>
        {address.host}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute" },
  pillPlace: { position: "absolute", height: materialBarPill.height + materialBarPill.shadowRoom * 2, paddingVertical: materialBarPill.shadowRoom, alignItems: "center", justifyContent: "flex-end" },
  pill: { flexDirection: "row", alignItems: "center", gap: materialBarPill.spacing, maxWidth: materialBarPill.maxWidth, height: materialBarPill.height, paddingHorizontal: materialBarPill.sideInset, borderRadius: materialShape.full, overflow: "hidden", elevation: 3 },
  pillHost: { flexShrink: 1 },
  hidden: { opacity: 0, elevation: 0 },
  siteSettingsLayer: { ...StyleSheet.absoluteFill, elevation: 4, zIndex: 1 },
});
