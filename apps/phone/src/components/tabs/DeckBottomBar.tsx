import { useEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputInstance, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floatingBarCenter } from "../../lib/deckGeometry";
import { haptics } from "../../state/app/haptics";
import { newIncognitoTab, newRegularTab, newTab, reopenLastClosed, switchDeckIncognito } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { capsule, chromeLayout, ChromeSurface, deckChromeLayout, deckChromeMotion, font, iPhoneOr, PressScale, rolesFor, startLayout, tabsCurve, tabsLayout, tabsMotion, useReduceMotion, useTheme, type MenuItem, SystemGlyph } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { deckLook } from "./deckLook";
import { useKeyboardTopFromBottom } from "../search/useKeyboardHeight";
import { FadingGlyphs, GlassPlusButton, type ChromeFade } from "./ChromeButtons";
import { besideStrip, DUO_BAR, duoFieldReach, type BottomBarLayout } from "../../lib/bottomBarSpan";
import { t } from "../../lib/uiLanguage";


type Props = {
  shown: boolean;
  barCenterY: number;
  deckHeight: number;
  width: number;
  layout: BottomBarLayout;
  incognito: boolean;
  privateCount?: number;
  onCloseIncognito?: () => void;
  onQuery: (needle: string) => void;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
} & ChromeFade;

export function plusMenu(incognito: boolean, canReopen: boolean): MenuItem[] {
  return [
    ...(incognito ? [{ label: t(`New Tab`), onPress: newRegularTab }, { label: t(`New Incognito Tab`), onPress: newTab }] : [{ label: t(`New Incognito Tab`), onPress: newIncognitoTab }]),
    ...(canReopen ? [{ label: t(`Reopen Closed Tab`), onPress: reopenLastClosed }] : []),
  ];
}

export function PlusMenuButton({ width, label, testID, dark, incognito = false, place, menusShown = true, frost, onMenu, ...fade }: { width: number; label: string; testID: string; dark: boolean; incognito?: boolean; place: ViewStyle; menusShown?: boolean; frost?: string | null; onMenu?: (open: boolean) => void } & ChromeFade) {
  const tabIncognito = useIncognito();
  const canReopen = useCanReopen();
  return (
    <MenuTrigger items={plusMenu(tabIncognito, canReopen)} trigger="longPress" haptic={menuOpenedHaptic} disabled={!menusShown} frost={frost} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} place={place} style={{ width, height: startLayout.barPlus.height }}>
      {({ onLongPress }) => <GlassPlusButton width={width} label={label} testID={testID} dark={dark} incognito={incognito} {...fade} onPress={newTab} onLongPress={onLongPress ?? noop} />}
    </MenuTrigger>
  );
}

const noop = () => undefined;

export function IncognitoSwitch({ incognito, dark, onLongPress, glassShown, glassShownMs, glyphFade }: { incognito: boolean; dark: boolean; onLongPress?: () => void } & ChromeFade) {
  const size = { width: deckChromeLayout.barCircle, height: deckChromeLayout.barCircle };
  const darkGlass = incognito && dark;
  return (
    <PressScale label={t(`Incognito`)} hint={incognito ? t(`Shows your tabs.`) : t(`Shows your Incognito tabs.`)} checked={incognito} onPress={switchDeckIncognito} onLongPress={onLongPress} longPressLabel={onLongPress ? t(`Close Incognito Tabs`) : undefined} onPressIn={haptics.barPress} style={size}>
      <ChromeSurface testID="deckBarIncognito" shape="circle" cornerRadius={capsule(deckChromeLayout.barCircle)} incognito={darkGlass} dark={dark || darkGlass} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size]}>
        <FadingGlyphs testID="deckBarIncognitoGlyph" pointerEvents="none" fade={glyphFade} style={[styles.centered, size]}>
          <IncognitoEyes incognito={incognito} size={deckChromeLayout.incognitoEyes} color={rolesFor(dark).label} />
        </FadingGlyphs>
      </ChromeSurface>
    </PressScale>
  );
}

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

export function SearchTabsField({ search, testID = "deckSearchTabs", style, resting = false, contentStyle, glassShown, glassShownMs, glyphFade }: { search: SearchTabs; testID?: string; style?: StyleProp<ViewStyle>; resting?: boolean; contentStyle?: ComponentProps<typeof Animated.View>["style"] } & ChromeFade) {
  const roles = useTheme();
  const dark = roles.dark;
  const { input, text, change, focus, blur } = search;
  return (
    <Pressable accessible={false} onPress={() => input.current?.focus()} style={style} collapsable={false} pointerEvents={resting ? "none" : "auto"} importantForAccessibility={resting ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={resting}>
      <ChromeSurface testID={testID} shape="capsule" cornerRadius={deckLook.fieldCorner} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.search, { paddingRight: text ? deckChromeLayout.searchTrailFilled : deckChromeLayout.searchTrail }]}>
        <Animated.View testID={`${testID}Fade`} style={[styles.searchRow, contentStyle]}>
          <FadingGlyphs testID={`${testID}Content`} fade={glyphFade} style={styles.searchRow}>
            <View pointerEvents="none">
              <SystemGlyph testID="deckSearchGlyph" systemName="magnifyingglass" pointSize={14} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.secondaryLabel} />
            </View>
            <TextInput
              ref={input}
              testID="deckSearchField"
              accessibilityLabel={t(`Search Tabs`)}
              placeholder={t(`Search Tabs`)}
              placeholderTextColor={iPhoneOr(roles.tertiaryLabel, roles.secondaryLabel)}
              selectionColor={roles.formAccent}
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
              <Pressable testID="deckSearchClear" accessibilityRole="button" accessibilityLabel={t(`Clear Search`)} onPress={() => change("")} style={styles.clear}>
                <SystemGlyph testID="deckSearchClearGlyph" systemName="xmark.circle.fill" pointSize={19} name="xmarkCircleFill" size={deckChromeLayout.clearGlyph} color={roles.secondaryLabel} />
              </Pressable>
            ) : null}
          </FadingGlyphs>
        </Animated.View>
      </ChromeSurface>
    </Pressable>
  );
}

export function DeckBottomBar({ shown, barCenterY, deckHeight, width, layout, incognito, privateCount = 0, onCloseIncognito, onQuery, menusShown = true, onMenu, glassShown, glassShownMs, glyphFade }: Props) {
  const fade = { glassShown, glassShownMs, glyphFade };
  const roles = useTheme();
  const dark = roles.dark;
  const search = useSearchTabs(shown, incognito, onQuery);
  const { focused } = search;
  const row = useRef<ViewInstance>(null);
  const keyboard = useKeyboardTopFromBottom(shown);
  const barCenterFromBottom = floatingBarCenter(useSafeAreaInsets().bottom, "android");
  const centerY = iPhoneOr(barCenterY, deckHeight - barCenterFromBottom);
  const rest = iPhoneOr<ViewStyle>({ top: centerY - deckChromeLayout.barCircle / 2 }, { bottom: barCenterFromBottom - deckChromeLayout.barCircle / 2 });
  const lift = focused && keyboard > 0 ? Math.max(0, centerY - deckBarAboveKeyboard(deckHeight, keyboard)) : 0;
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.value = withTiming(-lift, { duration: deckChromeMotion.keyboard, easing: tabsCurve.easeOut });
  }, [lift]);
  const riseStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));
  const { span, strip } = layout;
  const plusTop = strip ? (strip.ends ? strip.plus : strip.tabs) : 0;
  const plusPlace = strip ? { bottom: deckHeight - centerY - deckChromeLayout.barCircle / 2 - plusTop, ...besideStrip(strip, width, tabsLayout.menuWidth, deckChromeLayout.menuGap) } : { bottom: deckHeight - centerY + deckChromeLayout.barCircle / 2 + deckChromeLayout.menuGap, right: span.right, width: tabsLayout.menuWidth };
  const switchPlace = strip ? plusPlace : { bottom: deckHeight - centerY + deckChromeLayout.barCircle / 2 + deckChromeLayout.menuGap, left: span.left, width: tabsLayout.menuWidth };
  const closeIncognito: MenuItem[] = onCloseIncognito ? [{ label: t(`Close Incognito Tabs`), destructive: true, onPress: onCloseIncognito }] : [];
  const switchMenuShown = menusShown && privateCount > 0 && closeIncognito.length > 0;
  const incognitoSwitch = (
    <MenuTrigger items={closeIncognito} trigger="longPress" haptic={menuOpenedHaptic} disabled={!switchMenuShown} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} place={switchPlace} style={{ width: deckChromeLayout.barCircle, height: deckChromeLayout.barCircle }}>
      {({ onLongPress }) => <IncognitoSwitch incognito={incognito} dark={dark} onLongPress={switchMenuShown ? onLongPress : undefined} {...fade} />}
    </MenuTrigger>
  );
  const ends = strip?.ends ?? false;
  const opened = search.focused || search.text !== "";
  const reduceMotion = useReduceMotion();
  const growth = useSharedValue(opened ? 1 : 0);
  useEffect(() => {
    growth.value = reduceMotion ? withTiming(opened ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(opened ? 1 : 0, tabsMotion.barCollapse);
  }, [opened, reduceMotion]);
  const reach = duoFieldReach(width, layout, chromeLayout.barSideInset);
  const reachTo = reach ? (focused && keyboard > 0 ? reach.typing : opened ? reach.open : reach.rest) : 0;
  const edge = useSharedValue(reachTo);
  useEffect(() => {
    edge.value = reduceMotion ? withTiming(reachTo, { duration: tabsMotion.barCollapseReduced }) : withSpring(reachTo, tabsMotion.barCollapse);
  }, [reachTo, reduceMotion]);
  const reachSide = reach?.side ?? null;
  const grow = useAnimatedStyle(() => (reachSide === "marginLeft" ? { marginLeft: edge.value } : reachSide === "marginRight" ? { marginRight: edge.value } : {}), [reachSide]);
  const fieldFade = useAnimatedStyle(() => (ends ? { opacity: Math.min(Math.max(growth.value, 0), 1) } : {}), [ends]);
  const circleFade = useAnimatedStyle(() => ({ opacity: 1 - Math.min(Math.max(growth.value, 0), 1) }));
  const plus = <PlusMenuButton width={deckChromeLayout.barCircle} label={incognito ? t(`New Incognito Tab`) : t(`New Tab`)} testID="deckBarPlus" dark={dark} place={plusPlace} menusShown={menusShown} onMenu={onMenu} {...fade} />;
  const measure = () =>
    row.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) noteDeckBarTop(y);
    });
  useEffect(() => {
    watchDeckBar(measure);
    return () => watchDeckBar(null);
  }, []);
  return (
    <Animated.View pointerEvents="box-none" style={[styles.place, rest, riseStyle]}>
      <View ref={row} testID="deckBottomBar" onLayout={measure} pointerEvents="box-none" style={[styles.bar, { paddingLeft: span.left, paddingRight: span.right }]}>
        {strip?.ends ? null : incognitoSwitch}
        {ends ? (
          <Animated.View testID="deckSearchGrow" collapsable={false} style={[styles.searchHit, styles.grows, grow]}>
            <SearchTabsField search={search} style={styles.searchHit} resting={!opened} contentStyle={fieldFade} {...fade} />
            <Animated.View testID="deckSearchCircle" collapsable={false} style={[styles.searchCircle, strip?.side === "left" ? styles.circleLeading : styles.circleTrailing, circleFade]} pointerEvents={opened ? "none" : "auto"} importantForAccessibility={opened ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={opened}>
              <PressScale label={t(`Search Tabs`)} onPress={() => search.input.current?.focus()} onPressIn={haptics.barPress} style={[styles.centered, styles.circleHit]}>
                <FadingGlyphs fade={glyphFade} pointerEvents="none" style={styles.centered}>
                  <SystemGlyph testID="deckSearchCircleGlyph" systemName="magnifyingglass" pointSize={18} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.label} />
                </FadingGlyphs>
              </PressScale>
            </Animated.View>
          </Animated.View>
        ) : (
          <SearchTabsField search={search} style={styles.searchHit} {...fade} />
        )}
        {strip ? null : plus}
      </View>
      {strip ? <View testID="deckStripPlus" pointerEvents="box-none" style={[styles.strip, { left: strip.centerX - DUO_BAR.button / 2, top: plusTop }]}>{plus}</View> : null}
      {strip?.ends ? <View testID="deckStripIncognito" pointerEvents="box-none" style={[styles.strip, { left: strip.centerX - DUO_BAR.button / 2, top: strip.tabs }]}>{incognitoSwitch}</View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 0, right: 0 },
  centered: { alignItems: "center", justifyContent: "center" },
  bar: { height: deckChromeLayout.barCircle, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.barGap },
  strip: { position: "absolute", width: DUO_BAR.button, height: DUO_BAR.button },
  searchHit: { flex: 1, height: deckChromeLayout.barCircle },
  grows: { overflow: "hidden", borderRadius: deckLook.fieldCorner },
  searchCircle: { position: "absolute", top: 0, width: DUO_BAR.button, height: DUO_BAR.button },
  circleLeading: { left: 0 },
  circleTrailing: { right: 0 },
  circleHit: { width: DUO_BAR.button, height: DUO_BAR.button },
  search: { flex: 1, paddingLeft: deckChromeLayout.searchLead + 3 },
  searchRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing },
  field: { flex: 1, paddingVertical: 0 },
  clear: { width: deckChromeLayout.clearHit, height: deckChromeLayout.clearHit, alignItems: "center", justifyContent: "center" },
});
