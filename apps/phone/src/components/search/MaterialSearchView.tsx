import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedReaction, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { inlineOffer } from "../../lib/inlineOffer";
import { trayMaxHeight } from "../../lib/trayMotion";
import { MaterialSearchBar, type MaterialSearchBarHandle } from "../../platform/completingField";
import { activateRow, cancelSearch, submitSearch, toggleTrayIncognito } from "../../state/browse/store";
import { menuOpenedHaptic, trayRowActions } from "../../state/browse/tabMenus";
import { useSurface } from "../../state/browse/hooks";
import { useSearchCompletedFor, useSearchCompletion, useSearchFieldVersion, useSearchFromDockedMenu, useSearchInitialText, useSearchOpen, useSearchRows, useSearchSession, useSearchText } from "../../state/search/hooks";
import { refinedText, type TrayRow } from "../../state/search/omnibox";
import { searchState, setSearchText, typeSearch } from "../../state/search/store";
import { coverTray, useTrayCovers } from "../../state/search/trayBack";
import { useIncognito, useSelectedTab } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { canSearchByVoice, presentVoiceSearch, useVoice } from "../../state/voice/store";
import { FloatingMenu, space, Symbol, tabsLayout, usePresence, useTheme } from "../ui";
import type { Point } from "../../lib/menuPlace";
import { useMaterialSearchBarVisible } from "../browsing/PersistentMaterialBar";
import { barAddress } from "../browsing/FloatingBar";
import { MaterialAddressContent } from "../ui/MaterialBottomBar";
import { useReduceMotion } from "../ui/contrast";
import { rolesFromScheme } from "../ui/materialRoles";
import { MaterialSheet, materialSheetMs, type MaterialSheetSearch } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { MATERIAL_SEGMENT_GAP, materialBottomBar, materialDuration, materialSegmentCorners, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { SuggestionRow } from "./SuggestionRow";

const SHEET_ABOVE_KEYBOARD = 340;
const FOCUS_AFTER_ENTER_MS = 32;

export const materialSearchMs = (reduceMotion: boolean, entering: boolean) =>
  materialSheetMs(reduceMotion, entering) + (reduceMotion ? 0 : materialDuration.short2);

export const materialSearchFocusDelay = (enterMs: number, sinceOpenMs: number) =>
  Math.max(0, enterMs - sinceOpenMs) + FOCUS_AFTER_ENTER_MS;

export const countSearchExpansion = () => {
  if (!useTabs.getState().incognito) countUsage("search_sheet_expanded");
};

const countSearchBackSwipe = () => {
  if (!useTabs.getState().incognito) countUsage("tray_back_swiped");
};

export function useMaterialSheetSearch(searching: boolean): MaterialSheetSearch {
  const incognito = useIncognito();
  const insets = useSafeAreaInsets();
  const surface = useSurface();
  const { height, width, fontScale } = useWindowDimensions();
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  const preferred = SHEET_ABOVE_KEYBOARD + materialBottomBar.field * (fontScale - 1);
  const bodyMaxHeight = trayMaxHeight(preferred, height - insets.top, insets.bottom, materialSize.topAppBar);
  const keyboardPeak = useSharedValue(0);
  useAnimatedReaction(
    () => ({ lift: keyboard.height.value, width, searching }),
    (next, previous) => {
      if (!next.searching || !previous?.searching || previous.width !== next.width) keyboardPeak.value = next.searching ? next.lift : 0;
      else if (next.lift > keyboardPeak.value) keyboardPeak.value = next.lift;
    },
  );
  const sheetHeight = useDerivedValue(() => {
    const dock = Math.max(keyboard.height.value, keyboardPeak.value, insets.bottom);
    const available = Math.max(insets.bottom, height - insets.top - materialSize.topAppBar);
    const resting = Math.min(bodyMaxHeight + dock, Math.max(available, keyboard.height.value));
    const fieldClearOfKeyboard = keyboard.height.value + materialSize.touchTarget + materialBottomBar.field + materialBottomBar.inset;
    return Math.min(height - insets.top, Math.max(resting, fieldClearOfKeyboard));
  });
  const voice = useVoice((state) => state.presented);
  const covered = useTrayCovers((state) => state.covers > 0);
  const barSide = Math.max(insets.left, insets.right) + materialBottomBar.edge + materialBottomBar.pad + (surface === "start" ? 0 : materialSize.touchTarget + materialBottomBar.gap);
  return { height: sheetHeight, keyboard: keyboard.height, barSide, claimsBack: !voice && !covered, incognito, onBackSwipe: countSearchBackSwipe };
}

export function MaterialSearchTray() {
  const open = useSearchOpen();
  const fromDockedMenu = useSearchFromDockedMenu();
  const session = useSearchSession();
  const standalone = open && !fromDockedMenu;
  const presence = usePresence(standalone);
  if (!presence.mounted || fromDockedMenu) return null;
  return <StandaloneMaterialSearch key={session} open={standalone} onHidden={presence.hidden} />;
}

function StandaloneMaterialSearch({ open, onHidden }: { open: boolean; onHidden: () => void }) {
  useMaterialSearchBarVisible();
  const search = useMaterialSheetSearch(true);
  const scrollY = useSharedValue(0);
  return (
    <MaterialSheet
      open={open}
      onDismiss={cancelSearch}
      onHidden={onHidden}
      search={search}
      expandableList={{ scrollY, compactMaxHeight: SHEET_ABOVE_KEYBOARD, onExpand: countSearchExpansion }}
      dockedBar={(spread) => <MaterialSearchField open={open} spread={spread} />}
    >
      <MaterialSearchResults scrollY={scrollY} />
    </MaterialSheet>
  );
}

export function MaterialSearchField({ open, dockedMenu = false, spread }: { open: boolean; dockedMenu?: boolean; spread?: SharedValue<number> }) {
  const incognito = useIncognito();
  const { scheme, dark } = useMaterialTheme(incognito);
  const reduceMotion = useReduceMotion();
  const version = useSearchFieldVersion();
  const initialText = useSearchInitialText();
  const completion = useSearchCompletion();
  const completedFor = useSearchCompletedFor();
  const field = useRef<MaterialSearchBarHandle | null>(null);
  const fieldWidth = useRef(0);
  const surface = useSurface();
  const tab = useSelectedTab();
  const editingStyle = useAnimatedStyle(() => ({ opacity: spread ? Math.max(0, 2 * spread.value - 1) : 1 }));
  const landingStyle = useAnimatedStyle(() => ({ opacity: spread ? Math.max(0, 1 - 2 * spread.value) : 0 }));
  const openedAt = useRef(Date.now());
  const submitted = useRef(false);
  const [text, setText] = useState(() => searchState().text);
  useEffect(() => {
    setText(searchState().text);
  }, [version]);
  useEffect(() => {
    if (!open) {
      field.current?.blur();
      Keyboard.dismiss();
      return;
    }
    const enterMs = dockedMenu ? 0 : materialSearchMs(reduceMotion, true);
    const delay = materialSearchFocusDelay(enterMs, Date.now() - openedAt.current);
    const focus = setTimeout(() => field.current?.focus(), delay);
    return () => clearTimeout(focus);
  }, [version, open]);

  return (
    <View style={styles.fieldClip}>
      <Animated.View testID="materialSearchEditing" onLayout={(event) => { fieldWidth.current = event.nativeEvent.layout.width; }} style={[styles.bar, !open && fieldWidth.current > 0 ? { width: fieldWidth.current } : null, editingStyle]}>
        <MaterialSearchBar
          key={version}
          ref={field}
          testID="materialSearchBar"
          embedded
          style={styles.bar}
          text={text}
          offer={inlineOffer(completion, completedFor)}
          selectsAllOnFocus={version === 0 && Boolean(initialText)}
          incognito={incognito}
          showsVoice={canSearchByVoice()}
          appearance={{ dark, scheme }}
          onTypedChange={(next) => {
            setText(next);
            typeSearch(next);
          }}
          onSubmit={(displayed) => {
            if (submitted.current) return;
            if (submitSearch(displayed)) submitted.current = true;
          }}
          onClearPress={() => {
            setText("");
            setSearchText("");
          }}
          onVoicePress={presentVoiceSearch}
          onIncognitoPress={toggleTrayIncognito}
        />
      </Animated.View>
      {spread ? (
        <Animated.View testID="materialSearchLanding" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.landing, landingStyle]}>
          {surface === "browsing" && tab ? (
            <>
              <MaterialAddressContent address={barAddress(tab)} scheme={scheme} testID="materialSearchLandingHost" />
              <View style={styles.landingAction}><Symbol name="ellipsis" size={20} color={scheme.onSurfaceVariant} /></View>
            </>
          ) : (
            <>
              <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
              <Text numberOfLines={1} style={[materialType.bodyLarge, styles.landingText, { color: scheme.onSurfaceVariant }]}>{surface === "deck" ? "Search Tabs" : "Search or type address"}</Text>
            </>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

export function MaterialSearchResults({ scrollY }: { scrollY: SharedValue<number> }) {
  const incognito = useIncognito();
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const { scheme } = useMaterialTheme(incognito);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const rows = useSearchRows();
  const typed = useSearchText();
  const [menu, setMenu] = useState<{ row: TrayRow; at: Point } | null>(null);
  const menuOpen = menu !== null;
  useEffect(() => (menuOpen ? coverTray() : undefined), [menuOpen]);
  const refine = useCallback((row: TrayRow) => setSearchText(refinedText(row)), []);
  const showMenu = useCallback((row: TrayRow, at: Point) => {
    if (!trayRowActions(row).length) return;
    menuOpenedHaptic();
    setMenu({ row, at });
  }, []);
  if (incognito && !typed.trim())
    return (
      <View testID="materialSearchIncognitoNote" style={[styles.group, styles.note, materialSegmentCorners(0, 1), { backgroundColor: scheme.surfaceContainer }]}>
        <Symbol name="eyes" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        <Text style={[materialType.titleMedium, styles.noteText, { color: scheme.onSurfaceVariant }]}>You’re browsing Incognito</Text>
      </View>
    );
  const rowRoles = incognito ? rolesFromScheme(scheme, true) : theme;
  return (
    <View testID="materialSearchResults" style={styles.results}>
      <Animated.ScrollView testID="materialSearchRows" onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" keyboardDismissMode="none">
        {rows.length ? (
          <View testID="materialSearchGroup" style={[styles.group, styles.segments]}>
            {rows.map((row, index) => (
              <View
                key={index}
                testID="materialSearchSegment"
                style={[styles.segment, materialSegmentCorners(index, rows.length)]}
              >
                <SuggestionRow row={row} typed={typed} roles={rowRoles} menu={trayRowActions(row)} onActivate={activateRow} onRefine={refine} onMenu={showMenu} />
              </View>
            ))}
          </View>
        ) : null}
      </Animated.ScrollView>
      {menu ? (
        <FloatingMenu
          items={trayRowActions(menu.row).map((action) => ({ label: action.label, icon: action.icon, onPress: action.run }))}
          at={menu.at}
          dimmed
          frost={null}
          place={{ width: Math.min(tabsLayout.menuWidth, width - space.xl * 2) }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldClip: { width: "100%", height: materialBottomBar.field, overflow: "hidden", borderRadius: materialShape.full },
  landing: { ...StyleSheet.absoluteFill, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 4 },
  landingText: { flex: 1 },
  landingAction: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center" },
  bar: { width: "100%", height: materialBottomBar.field },
  results: { flex: 1 },
  group: { marginHorizontal: 16 },
  segments: { gap: MATERIAL_SEGMENT_GAP, paddingVertical: 4 },
  segment: { overflow: "hidden" },
  note: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  noteText: { flexShrink: 1 },
});
