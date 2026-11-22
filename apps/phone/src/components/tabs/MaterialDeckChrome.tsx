import { useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import type { MaterialScheme } from "../../lib/material/schemes";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen } from "../../state/tabs/hooks";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { Symbol, type MenuItem } from "../ui";
import { MATERIAL_STATE } from "../ui/materialRoles";
import { materialBottomBar, materialDuration, materialMove, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { MenuTrigger } from "../ui/MenuTrigger";
import { MaterialBottomBar, MaterialBarIconButton as MaterialIconButton } from "../ui/MaterialBottomBar";

import { useMaterialBarRegistration } from "../browsing/PersistentMaterialBar";
import { useKeyboardHeight } from "../search/useKeyboardHeight";
import { useSearchTabs } from "./DeckBottomBar";
import { deckMoreMenuItems, useDeckSpaces } from "./DeckHeader";
import { MATERIAL_DECK, useDeckScheme } from "./MaterialDeckLayout";
import { t } from "../../lib/uiLanguage";


export { MaterialBarIconButton as MaterialIconButton } from "../ui/MaterialBottomBar";

type Menus = { menusShown: boolean; onMenu: (open: boolean) => void };

type AnimatedOpacityStyle = ReturnType<typeof useAnimatedStyle>;

type ChromeProps = Menus & {
  shown: boolean;
  barBlocked?: boolean;
  safeTop: number;
  safeSide: number;
  safeBottom: number;
  deckHeight: number;
  incognito: boolean;
  privateCount: number;
  hasTabs: boolean;
  chromeStyle?: AnimatedOpacityStyle;
  onQuery: (needle: string) => void;
  onCloseIncognito: () => void;
  onCloseAll: () => void;
};

const ripple = (scheme: MaterialScheme, on: string = scheme.onSurface) => ({ color: withAlpha(on, MATERIAL_STATE.pressed), foreground: true });

export function MaterialDeckChrome({ shown, barBlocked, safeTop, safeSide, safeBottom, deckHeight, incognito, privateCount, hasTabs, chromeStyle, onQuery, onCloseIncognito, onCloseAll, menusShown, onMenu }: ChromeProps) {
  return (
    <>
      <MaterialDeckTopBar safeTop={safeTop} safeSide={safeSide} incognito={incognito} privateCount={privateCount} hasTabs={hasTabs} chromeStyle={chromeStyle} onCloseIncognito={onCloseIncognito} onCloseAll={onCloseAll} menusShown={menusShown} onMenu={onMenu} />
      <MaterialDeckBottomRow shown={shown} barBlocked={barBlocked} safeSide={safeSide} safeBottom={safeBottom} deckHeight={deckHeight} incognito={incognito} privateCount={privateCount} onCloseIncognito={onCloseIncognito} chromeStyle={chromeStyle} onQuery={onQuery} menusShown={menusShown} onMenu={onMenu} />
    </>
  );
}

export function MaterialDeckBackdrop({ incognito }: { incognito: boolean }) {
  const scheme = useDeckScheme(incognito);
  return <View testID="materialDeckBackdrop" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: scheme.surface }]} />;
}

type TopBarProps = Menus & { safeTop: number; safeSide: number; incognito: boolean; privateCount: number; hasTabs: boolean; chromeStyle?: AnimatedOpacityStyle; onCloseIncognito: () => void; onCloseAll: () => void };

export function MaterialDeckTopBar({ safeTop, safeSide, incognito, privateCount, hasTabs, chromeStyle, onCloseIncognito, onCloseAll, menusShown, onMenu }: TopBarProps) {
  const scheme = useDeckScheme(incognito);
  const canReopen = useCanReopen();
  const { syncEnabled, spaces, current, spaceItems } = useDeckSpaces();
  const side = safeSide + MATERIAL_DECK.barSide;
  const below = safeTop + materialSize.topAppBar;
  const menu = { trigger: "tap" as const, fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: () => onMenu(true), onClose: () => onMenu(false) };
  const moreItems = deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll });
  const title = current?.name ?? t(`Tabs`);
  return (
    <Animated.View testID="materialDeckTopBar" pointerEvents="box-none" style={[styles.topBar, { paddingTop: safeTop, height: safeTop + materialSize.topAppBar, paddingHorizontal: side, backgroundColor: scheme.surface }, chromeStyle]}>
      <View style={styles.titleSlot}>
        {current && spaces.length > 1 ? (
          <MenuTrigger items={spaceItems} {...menu} place={{ top: below, left: side + MATERIAL_DECK.titleInset }}>
            {({ onPress }) => (
              <Pressable
                testID="materialDeckSpace"
                accessibilityRole="button"
                accessibilityLabel={`Space, ${current.name}`}
                accessibilityHint={t(`Shows your Mac’s spaces.`)}
                android_ripple={ripple(scheme)}
                onPress={onPress}
                style={styles.spaceButton}
              >
                <Text numberOfLines={1} style={[materialType.titleLarge, styles.shrink, { color: scheme.onSurface }]}>
                  {current.name}
                </Text>
                <Symbol name="chevronDown" size={materialSize.icon} color={scheme.onSurfaceVariant} />
              </Pressable>
            )}
          </MenuTrigger>
        ) : (
          <Text testID="materialDeckTitle" accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.title, { color: scheme.onSurface }]}>
            {title}
          </Text>
        )}
      </View>
      <MenuTrigger items={moreItems} {...menu} place={{ top: below, right: side }}>
        {({ onPress }) => <MaterialIconButton testID="materialDeckMore" icon="ellipsis" label={t(`More`)} scheme={scheme} turned onPress={onPress ?? noop} />}
      </MenuTrigger>
    </Animated.View>
  );
}

type BottomProps = Menus & { barBlocked?: boolean; shown: boolean; safeSide: number; safeBottom: number; deckHeight: number; incognito: boolean; privateCount?: number; onCloseIncognito?: () => void; chromeStyle?: AnimatedOpacityStyle; onQuery: (needle: string) => void };

export const materialKeyboardLift = (keyboard: number, safeBottom: number, os: string) => Math.max(0, keyboard + MATERIAL_DECK.keyboardGap - (os === "android" ? 0 : safeBottom) - materialBottomBar.inset);

export function MaterialDeckBottomRow({ shown, barBlocked = false, safeSide, safeBottom, incognito, privateCount = 0, onCloseIncognito, chromeStyle, onQuery, menusShown, onMenu }: BottomProps) {
  const scheme = useDeckScheme(incognito);
  const canReopen = useCanReopen();
  const search = useSearchTabs(shown, incognito, onQuery);
  const { focused } = search;
  const keyboard = useKeyboardHeight(shown);
  const lift = focused && keyboard > 0 ? materialKeyboardLift(keyboard, safeBottom, Platform.OS) : 0;
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.value = materialMove(-lift, "emphasized", materialDuration.short4);
  }, [lift]);
  const riseStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));
  const row = useRef<ViewInstance>(null);
  const measure = () =>
    row.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) noteDeckBarTop(y);
    });
  const hosted = useMaterialBarRegistration("deck", {
    bar: { isTabOverview: true, scheme, search, incognito, privateCount, onCloseIncognito, canReopen, menusShown, onMenu, container: { ref: row, onLayout: measure, style: riseStyle } },
    hidden: !shown,
    blocked: !menusShown || barBlocked,
    measure,
  });
  useEffect(() => {
    if (hosted) return;
    watchDeckBar(measure);
    return () => watchDeckBar(null);
  }, [hosted]);
  if (hosted) return null;
  const side = safeSide + materialBottomBar.edge;
  return (
    <MaterialBottomBar
      isTabOverview
      scheme={scheme}
      search={search}
      incognito={incognito}
      privateCount={privateCount}
      onCloseIncognito={onCloseIncognito}
      canReopen={canReopen}
      menusShown={menusShown}
      onMenu={onMenu}
      container={{ ref: row, testID: "materialDeckBottomRow", onLayout: measure, pointerEvents: barBlocked ? "none" : "box-none", style: [styles.bottomRow, { bottom: safeBottom + materialBottomBar.inset, left: side, right: side }, riseStyle, chromeStyle] }}
    />
  );
}

export function MaterialDeckEmpty({ centerY, showsArchive, onArchive, searching = false, incognito }: { centerY: number; showsArchive: boolean; onArchive: () => void; searching?: boolean; incognito: boolean }) {
  const scheme = useDeckScheme(incognito);
  return (
    <View testID="materialDeckEmpty" pointerEvents="box-none" style={[styles.empty, { top: centerY - materialSize.listItemTwoLine }]}>
      <Text style={[materialType.titleLarge, styles.centered, { color: scheme.onSurface }]}>{searching ? t(`No Matching Tabs`) : t(`No Open Tabs`)}</Text>
      {searching ? null : <Text style={[materialType.bodyMedium, styles.centered, { color: scheme.onSurfaceVariant }]}>Tabs you open appear here. Inactive tabs move to the Archive.</Text>}
      {showsArchive && !searching ? (
        <Pressable accessibilityRole="button" android_ripple={ripple(scheme, scheme.primary)} onPress={onArchive} style={styles.textButton}>
          <Text style={[materialType.labelLarge, { color: scheme.primary }]}>Open Archive</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center" },
  titleSlot: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  title: { paddingHorizontal: MATERIAL_DECK.titleInset, flexShrink: 1 },
  shrink: { flexShrink: 1 },
  spaceButton: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: materialSize.touchTarget, paddingLeft: MATERIAL_DECK.titleInset, paddingRight: 8, borderRadius: materialShape.full, overflow: "hidden", flexShrink: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, height: MATERIAL_DECK.chipHeight, paddingHorizontal: 12, borderRadius: materialShape.small, overflow: "hidden", marginHorizontal: 4 },
  count: { fontVariant: ["tabular-nums"] },
  bottomRow: { position: "absolute" },
  empty: { position: "absolute", left: 24, right: 24, alignItems: "center", gap: 8 },
  centered: { textAlign: "center" },
  textButton: { minHeight: materialSize.touchTarget, minWidth: materialSize.touchTarget, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderRadius: materialShape.full, overflow: "hidden", marginTop: 8 },
});
