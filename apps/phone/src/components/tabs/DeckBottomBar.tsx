import { useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputInstance, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { newIncognitoTab, newRegularTab, newTab, reopenLastClosed } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { capsule, ChromeSurface, deckChromeLayout, deckChromeMotion, font, iPhoneOr, startLayout, Symbol, tabsCurve, tabsLayout, useTheme, type MenuItem, SystemGlyph } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { useKeyboardHeight } from "../search/useKeyboardHeight";
import { FadingGlyphs, GlassCircleButton, GlassPlusButton, type ChromeFade } from "./ChromeButtons";

type Props = {
  shown: boolean;
  barCenterY: number;
  deckHeight: number;
  safeSide: number;
  incognito: boolean;
  grid?: boolean;
  gridAvailable: boolean;
  onGrid: () => void;
  onQuery: (needle: string) => void;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
} & ChromeFade;

export function plusMenu(incognito: boolean, canReopen: boolean): MenuItem[] {
  return [
    ...(incognito ? [{ label: "New Tab", onPress: newRegularTab }, { label: "New Incognito Tab", onPress: newTab }] : [{ label: "New Incognito Tab", onPress: newIncognitoTab }]),
    ...(canReopen ? [{ label: "Reopen Closed Tab", onPress: reopenLastClosed }] : []),
  ];
}

export function PlusMenuButton({ width, label, testID, dark, incognito = false, place, menusShown = true, onMenu, ...fade }: { width: number; label: string; testID: string; dark: boolean; incognito?: boolean; place: ViewStyle; menusShown?: boolean; onMenu?: (open: boolean) => void } & ChromeFade) {
  const tabIncognito = useIncognito();
  const canReopen = useCanReopen();
  return (
    <MenuTrigger items={plusMenu(tabIncognito, canReopen)} trigger="longPress" haptic={menuOpenedHaptic} disabled={!menusShown} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} place={place} style={{ width, height: startLayout.barPlus.height }}>
      {({ onLongPress }) => <GlassPlusButton width={width} label={label} testID={testID} dark={dark} incognito={incognito} {...fade} onPress={newTab} onLongPress={onLongPress ?? noop} />}
    </MenuTrigger>
  );
}

const noop = () => undefined;

export const deckBarAboveKeyboard = (deckHeight: number, keyboard: number) => deckHeight - keyboard - deckChromeLayout.barGap - deckChromeLayout.barCircle / 2;

export type SearchTabs = { input: RefObject<TextInputInstance | null>; text: string; focused: boolean; change: (next: string) => void; focus: () => void; blur: () => void };

export function useSearchTabs(shown: boolean, incognito: boolean, onQuery: (needle: string) => void): SearchTabs {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const needle = useRef("");
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    if (shown) return;
    input.current?.blur();
    needle.current = "";
    setText("");
    setFocused(false);
  }, [shown]);
  const change = (next: string) => {
    setText(next);
    const trimmed = next.trim();
    if (trimmed === needle.current) return;
    needle.current = trimmed;
    onQuery(trimmed);
  };
  const focus = () => {
    setFocused(true);
    if (!incognito) countUsage("search_tabs_opened");
  };
  return { input, text, focused, change, focus, blur: () => setFocused(false) };
}

export function SearchTabsField({ search, testID = "deckSearchTabs", style, glassShown, glassShownMs, glyphFade }: { search: SearchTabs; testID?: string; style?: StyleProp<ViewStyle> } & ChromeFade) {
  const roles = useTheme();
  const dark = roles.dark;
  const { input, text, change, focus, blur } = search;
  return (
    <Pressable accessible={false} onPress={() => input.current?.focus()} style={style}>
      <ChromeSurface testID={testID} shape="capsule" cornerRadius={capsule(deckChromeLayout.barCircle)} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.search, { paddingRight: text ? deckChromeLayout.searchTrailFilled : deckChromeLayout.searchTrail }]}>
        <FadingGlyphs testID={`${testID}Content`} fade={glyphFade} style={styles.searchRow}>
          <View pointerEvents="none">
            <SystemGlyph testID="deckSearchGlyph" systemName="magnifyingglass" pointSize={14} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.secondaryLabel} />
          </View>
          <TextInput
            ref={input}
            testID="deckSearchField"
            accessibilityLabel="Search Tabs"
            placeholder="Search Tabs"
            placeholderTextColor={iPhoneOr(roles.tertiaryLabel, roles.secondaryLabel)}
            value={text}
            onChangeText={change}
            onFocus={focus}
            onBlur={blur}
            onSubmitEditing={() => input.current?.blur()}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            keyboardAppearance={dark ? "dark" : "light"}
            style={[font.callout, styles.field, { color: roles.label }]}
          />
          {text ? (
            <Pressable testID="deckSearchClear" accessibilityRole="button" accessibilityLabel="Clear Search" onPress={() => change("")} style={styles.clear}>
              <SystemGlyph testID="deckSearchClearGlyph" systemName="xmark.circle.fill" pointSize={19} name="xmarkCircleFill" size={deckChromeLayout.clearGlyph} color={roles.secondaryLabel} />
            </Pressable>
          ) : null}
        </FadingGlyphs>
      </ChromeSurface>
    </Pressable>
  );
}

export function DeckBottomBar({ shown, barCenterY, deckHeight, safeSide, incognito, grid = false, gridAvailable, onGrid, onQuery, menusShown = true, onMenu, glassShown, glassShownMs, glyphFade }: Props) {
  const fade = { glassShown, glassShownMs, glyphFade };
  const roles = useTheme();
  const dark = roles.dark;
  const search = useSearchTabs(shown, incognito, onQuery);
  const { input, focused } = search;
  const row = useRef<ViewInstance>(null);
  const keyboard = useKeyboardHeight(shown);
  const lift = focused && keyboard > 0 ? Math.max(0, barCenterY - deckBarAboveKeyboard(deckHeight, keyboard)) : 0;
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.value = withTiming(-lift, { duration: deckChromeMotion.keyboard, easing: tabsCurve.easeOut });
  }, [lift]);
  const riseStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));
  const measure = () =>
    row.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) noteDeckBarTop(y);
    });
  useEffect(() => {
    watchDeckBar(measure);
    return () => watchDeckBar(null);
  }, []);
  return (
    <Animated.View pointerEvents="box-none" style={[styles.place, { top: barCenterY - deckChromeLayout.barCircle / 2 }, riseStyle]}>
      <View ref={row} testID="deckBottomBar" onLayout={measure} pointerEvents="box-none" style={[styles.bar, { paddingHorizontal: safeSide + deckChromeLayout.barSideInset }]}>
        {gridAvailable ? (
          <GlassCircleButton
            icon={grid ? "squareStack" : "squareGrid2x2"}
            label={grid ? "Show as Stack" : "Show as Grid"}
            testID="deckBarGrid"
            diameter={deckChromeLayout.barCircle}
            dark={dark}
            {...fade}
            onPress={() => {
              input.current?.blur();
              onGrid();
            }}
          />
        ) : null}
        <SearchTabsField search={search} style={styles.searchHit} {...fade} />
        <PlusMenuButton width={deckChromeLayout.barCircle} label={incognito ? "New Incognito Tab" : "New Tab"} testID="deckBarPlus" dark={dark} place={{ bottom: deckHeight - barCenterY + deckChromeLayout.barCircle / 2 + deckChromeLayout.menuGap, right: deckChromeLayout.barSideInset, width: tabsLayout.menuWidth }} menusShown={menusShown} onMenu={onMenu} {...fade} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 0, right: 0 },
  bar: { height: deckChromeLayout.barCircle, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.barGap },
  searchHit: { flex: 1, height: deckChromeLayout.barCircle },
  search: { flex: 1, paddingLeft: deckChromeLayout.searchLead },
  searchRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing },
  field: { flex: 1, paddingVertical: 0 },
  clear: { width: deckChromeLayout.clearHit, height: deckChromeLayout.clearHit, alignItems: "center", justifyContent: "center" },
});
