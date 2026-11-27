import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { actionWords, incognitoWords } from "../../lib/sharedWords";
import { Platform, Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputInstance, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { dispatchCommand, runOnJS, useAnimatedKeyboard, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useEvent, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floatingBarCenter } from "../../lib/deckGeometry";
import { haptics } from "../../state/app/haptics";
import { deckHitAccepted, switchDeckIncognito } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { countUsage } from "../../state/telemetry/telemetry";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { capsule, chromeLayout, ChromeSurface, controlSize, deckChromeLayout, deckChromeMotion, FieldAccessory, font, iconRoles, iPhoneOr, PressInPlace, rolesFor, ToggleIconButton, tabsCurve, tabsLayout, tabsMotion, useReduceMotion, useTheme, type MenuItem, SystemGlyph } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { PressedGlyph } from "../ui/PressInPlace";
import { FabricCatchUp } from "../ui/FabricCatchUp";
import { deckLook } from "./deckLook";
import { useKeyboardTopFromBottom } from "../search/useKeyboardHeight";
import { FadingGlyphs, PlusMenuButton, type ChromeFade } from "./ChromeButtons";
import { besideStrip, duoFieldReach, type BottomBarLayout } from "../../lib/bottomBarSpan";
import { DeckHitTarget } from "./DeckHitTarget";
import { claimDeckSearchFocus } from "../../state/browse/deckTurn";

type Props = {
  searchOpener?: MutableRefObject<(() => void) | null>;
  shown: boolean;
  barCenterY: number;
  deckHeight: number;
  width: number;
  layout: BottomBarLayout;
  incognito: boolean;
  privateCount?: number;
  onCloseIncognito?: () => void;
  onCloseAll?: () => void;
  onQuery: (needle: string) => void;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
  hits?: boolean;
} & ChromeFade;


export function IncognitoSwitch({ incognito, dark, onLongPress, glassShown, glassShownMs, glyphFade }: { incognito: boolean; dark: boolean; onLongPress?: () => void } & ChromeFade) {
  const size = { width: controlSize.bar, height: controlSize.bar };
  return (
    <ToggleIconButton
      testID="deckBarIncognitoSwitch"
      label="Incognito"
      hint={incognito ? "Shows your tabs." : "Shows your Incognito tabs."}
      checked={incognito}
      onChange={switchIncognitoSide}
      onLongPress={onLongPress}
      longPressLabel={onLongPress ? incognitoWords.closeIncognitoTabs : undefined}
      onPressIn={haptics.barPress}
      visual={controlSize.bar}
      dims="glyph"
    >
      <ChromeSurface testID="deckBarIncognito" shape="circle" cornerRadius={capsule(controlSize.bar)} incognito={incognito} dark={dark || incognito} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size]}>
        <FadingGlyphs testID="deckBarIncognitoGlyph" pointerEvents="none" fade={glyphFade} style={[styles.centered, size]}>
          <PressedGlyph>
            <IncognitoEyes incognito={incognito} size={deckChromeLayout.incognitoEyes} color={rolesFor(dark).label} />
          </PressedGlyph>
        </FadingGlyphs>
      </ChromeSurface>
    </ToggleIconButton>
  );
}


const switchIncognitoSide = () => switchDeckIncognito();

const LIVE_KEYBOARD = Platform.OS === "ios";

function LiveKeyboardTop({ into }: { into: SharedValue<number> }) {
  const keyboard = useAnimatedKeyboard();
  useAnimatedReaction(
    () => keyboard.height.value,
    (height) => {
      into.value = height;
    },
  );
  useEffect(
    () => () => {
      into.value = 0;
    },
    [into],
  );
  return null;
}

const KEYBOARD_DOWN = 0;
const KEYBOARD_LEAVING = 1;
const KEYBOARD_OURS = 2;

export const deckBarAboveKeyboard = (deckHeight: number, keyboard: number) => {
  "worklet";
  return deckHeight - keyboard - deckChromeLayout.barGap - controlSize.bar / 2;
};

export const deckBarLift = (centerY: number, deckHeight: number, keyboardTop: number) => {
  "worklet";
  return keyboardTop > 0 ? Math.max(0, centerY - deckBarAboveKeyboard(deckHeight, keyboardTop)) : 0;
};

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

const TurnTextInput = Animated.createAnimatedComponent(TextInput) as unknown as (props: ComponentProps<typeof TextInput> & { onFocusOnTurn?: unknown }) => ReactNode;

export function SearchTabsField({ search, testID = "deckSearchTabs", style, resting = false, incognito = false, contentStyle, glassShown, glassShownMs, glyphFade }: { search: SearchTabs; testID?: string; style?: StyleProp<ViewStyle>; resting?: boolean; incognito?: boolean; contentStyle?: ComponentProps<typeof Animated.View>["style"] } & ChromeFade) {
  const roles = useTheme();
  const dark = roles.dark || incognito;
  const { input, text, change, focus, blur } = search;
  const nativeField = useAnimatedRef<TextInput>();
  const fieldRef = useCallback(
    (node: TextInputInstance | null) => {
      input.current = node;
      nativeField(node as never);
    },
    [input, nativeField],
  );
  const focusOnTurn = useEvent(() => {
    "worklet";
    const claimed = claimDeckSearchFocus();
    if (claimed === "refused") dispatchCommand(nativeField, "blur");
    else if (claimed) runOnJS(deckHitAccepted)(claimed);
  }, ["onFocus"]);
  return (
    <Pressable accessible={false} onPress={() => input.current?.focus()} style={style} collapsable={false} pointerEvents={resting ? "none" : "auto"} importantForAccessibility={resting ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={resting}>
      <ChromeSurface testID={testID} shape="capsule" cornerRadius={deckLook.fieldCorner} incognito={incognito} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.search, { paddingRight: text ? deckLook.clearTrail : deckChromeLayout.searchTrail }]}>
        <Animated.View testID={`${testID}Fade`} style={[styles.searchRow, contentStyle]}>
          <FadingGlyphs testID={`${testID}Content`} fade={glyphFade} style={styles.searchRow}>
            <View pointerEvents="none">
              <SystemGlyph testID="deckSearchGlyph" systemName="magnifyingglass" pointSize={14} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.secondaryLabel} />
            </View>
            <TurnTextInput
              ref={fieldRef}
              onFocusOnTurn={focusOnTurn}
              testID="deckSearchField"
              accessibilityLabel="Search Tabs"
              placeholder="Search Tabs"
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
              <FieldAccessory testID="deckSearchClear" icon={iconRoles.clearText} label={actionWords.clearText} color={roles.secondaryLabel} onPress={() => change("")} />
            ) : null}
          </FadingGlyphs>
        </Animated.View>
      </ChromeSurface>
    </Pressable>
  );
}

export function DeckBottomBar({ searchOpener, shown, barCenterY, deckHeight, width, layout, incognito, privateCount = 0, onCloseIncognito, onCloseAll, onQuery, menusShown = true, onMenu, hits = false, glassShown, glassShownMs, glyphFade }: Props) {
  const fade = { glassShown, glassShownMs, glyphFade };
  const roles = useTheme();
  const dark = roles.dark || incognito;
  const search = useSearchTabs(shown, incognito, onQuery);
  const { focused } = search;
  useLayoutEffect(() => {
    if (!searchOpener) return;
    searchOpener.current = () => search.input.current?.focus();
    return () => {
      searchOpener.current = null;
    };
  }, [searchOpener, search.input]);
  const row = useRef<ViewInstance>(null);
  const reach = duoFieldReach(width, layout, chromeLayout.barSideInset);
  const keyboard = useKeyboardTopFromBottom(shown && (!LIVE_KEYBOARD || reach !== null));
  const keyboardTop = useSharedValue(0);
  const barCenterFromBottom = floatingBarCenter(useSafeAreaInsets().bottom, "android");
  const centerY = iPhoneOr(barCenterY, deckHeight - barCenterFromBottom);
  const rest = iPhoneOr<ViewStyle>({ top: centerY - controlSize.bar / 2 }, { bottom: barCenterFromBottom - controlSize.bar / 2 });
  const focusedNow = useSharedValue(focused);
  const typing = useSharedValue(focused);
  useLayoutEffect(() => {
    focusedNow.value = focused;
  }, [focused]);
  useAnimatedReaction(
    () => (focusedNow.value ? KEYBOARD_OURS : keyboardTop.value > 0 ? KEYBOARD_LEAVING : KEYBOARD_DOWN),
    (now) => {
      if (now === KEYBOARD_OURS) typing.value = true;
      else if (now === KEYBOARD_DOWN) typing.value = false;
    },
  );
  const timedLift = focused && keyboard > 0 ? deckBarLift(centerY, deckHeight, keyboard) : 0;
  const rise = useSharedValue(0);
  useEffect(() => {
    if (!LIVE_KEYBOARD) rise.value = withTiming(-timedLift, { duration: deckChromeMotion.keyboard, easing: tabsCurve.easeOut });
  }, [timedLift]);
  const riseNow = () => {
    "worklet";
    if (!LIVE_KEYBOARD) return rise.value;
    return typing.value ? -deckBarLift(centerY, deckHeight, keyboardTop.value) : 0;
  };
  const riseStyle = useAnimatedStyle(() => {
    if (!LIVE_KEYBOARD) return { transform: [{ translateY: rise.value }] };
    return { transform: [{ translateY: typing.value ? -deckBarLift(centerY, deckHeight, keyboardTop.value) : 0 }] };
  }, [centerY, deckHeight]);
  const { span, strip } = layout;
  const rowHits = hits && !strip;
  const rowTop = centerY - controlSize.bar / 2;
  const plusTop = strip ? (strip.ends ? strip.plus : strip.tabs) : 0;
  const plusPlace = strip ? { bottom: deckHeight - centerY - controlSize.bar / 2 - plusTop, ...besideStrip(strip, width, tabsLayout.menuWidth, deckChromeLayout.menuGap) } : { bottom: deckHeight - centerY + controlSize.bar / 2 + deckChromeLayout.menuGap, right: span.right, width: tabsLayout.menuWidth };
  const switchPlace = strip ? plusPlace : { bottom: deckHeight - centerY + controlSize.bar / 2 + deckChromeLayout.menuGap, left: span.left, width: tabsLayout.menuWidth };
  const closeIncognito: MenuItem[] = onCloseIncognito ? [{ label: incognitoWords.closeIncognitoTabs, icon: "xmark", destructive: true, onPress: onCloseIncognito }] : [];
  const switchMenuShown = menusShown && privateCount > 0 && closeIncognito.length > 0;
  const incognitoSwitch = (
    <DeckHitTarget control="privacy" live={rowHits} originY={rowTop} style={styles.circleHit}>
      <MenuTrigger items={closeIncognito} trigger="longPress" haptic={menuOpenedHaptic} disabled={!switchMenuShown} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} place={switchPlace} style={{ width: controlSize.bar, height: controlSize.bar }}>
        {({ onLongPress }) => <IncognitoSwitch incognito={incognito} dark={dark} onLongPress={switchMenuShown ? onLongPress : undefined} {...fade} />}
      </MenuTrigger>
    </DeckHitTarget>
  );
  const ends = strip?.ends ?? false;
  const opened = search.focused || search.text !== "";
  const reduceMotion = useReduceMotion();
  const growth = useSharedValue(opened ? 1 : 0);
  useLayoutEffect(() => {
    growth.value = reduceMotion ? withTiming(opened ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(opened ? 1 : 0, tabsMotion.barCollapse);
  }, [opened, reduceMotion]);
  const reachTo = reach ? (focused && keyboard > 0 ? reach.typing : opened ? reach.open : reach.rest) : 0;
  const edge = useSharedValue(reachTo);
  useLayoutEffect(() => {
    edge.value = reduceMotion ? withTiming(reachTo, { duration: tabsMotion.barCollapseReduced }) : withSpring(reachTo, tabsMotion.barCollapse);
  }, [reachTo, reduceMotion]);
  const reachSide = reach?.side ?? null;
  const grow = useAnimatedStyle(() => (reachSide === "marginLeft" ? { marginLeft: edge.value } : reachSide === "marginRight" ? { marginRight: edge.value } : {}), [reachSide]);
  const fieldFade = useAnimatedStyle(() => (ends ? { opacity: Math.min(Math.max(growth.value, 0), 1) } : {}), [ends]);
  const circleFade = useAnimatedStyle(() => ({ opacity: 1 - Math.min(Math.max(growth.value, 0), 1) }));
  const plus = (
    <DeckHitTarget control="plus" live={rowHits} originY={rowTop} style={styles.circleHit}>
      <PlusMenuButton width={controlSize.bar} label={incognito ? actionWords.newIncognitoTab : actionWords.newTab} testID="deckBarPlus" dark={dark} incognito={incognito} place={plusPlace} menusShown={menusShown} onMenu={onMenu} onCloseAll={onCloseAll} {...fade} />
    </DeckHitTarget>
  );
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
      {shown ? <FabricCatchUp motion={riseNow} testID="deckBarFabricCatchUp" /> : null}
      {shown && LIVE_KEYBOARD ? <LiveKeyboardTop into={keyboardTop} /> : null}
      <View ref={row} testID="deckBottomBar" onLayout={measure} pointerEvents="box-none" style={[styles.bar, { paddingLeft: span.left, paddingRight: span.right }]}>
        {strip?.ends ? null : incognitoSwitch}
        {ends ? (
          <Animated.View testID="deckSearchGrow" collapsable={false} style={[styles.searchHit, styles.grows, grow]}>
            <SearchTabsField search={search} style={styles.searchHit} resting={!opened} incognito={incognito} contentStyle={fieldFade} {...fade} />
            <Animated.View testID="deckSearchCircle" collapsable={false} style={[styles.searchCircle, strip?.side === "left" ? styles.circleLeading : styles.circleTrailing, circleFade]} pointerEvents={opened ? "none" : "auto"} importantForAccessibility={opened ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={opened}>
              <PressInPlace label="Search Tabs" onPress={() => search.input.current?.focus()} onPressIn={haptics.barPress} style={[styles.centered, styles.circleHit]}>
                <FadingGlyphs fade={glyphFade} pointerEvents="none" style={styles.centered}>
                  <SystemGlyph testID="deckSearchCircleGlyph" systemName="magnifyingglass" pointSize={18} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.label} />
                </FadingGlyphs>
              </PressInPlace>
            </Animated.View>
          </Animated.View>
        ) : (
          <DeckHitTarget control="search" live={rowHits} originY={rowTop} style={styles.searchHit}>
            <SearchTabsField search={search} style={styles.searchHit} incognito={incognito} {...fade} />
          </DeckHitTarget>
        )}
        {strip ? null : plus}
      </View>
      {strip ? <View testID="deckStripPlus" pointerEvents="box-none" style={[styles.strip, { left: strip.centerX - controlSize.bar / 2, top: plusTop }]}>{plus}</View> : null}
      {strip?.ends ? <View testID="deckStripIncognito" pointerEvents="box-none" style={[styles.strip, { left: strip.centerX - controlSize.bar / 2, top: strip.tabs }]}>{incognitoSwitch}</View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 0, right: 0 },
  centered: { alignItems: "center", justifyContent: "center" },
  bar: { height: controlSize.bar, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.barGap },
  strip: { position: "absolute", width: controlSize.bar, height: controlSize.bar },
  searchHit: { flex: 1, height: controlSize.bar },
  grows: { overflow: "hidden", borderRadius: deckLook.fieldCorner },
  searchCircle: { position: "absolute", top: 0, width: controlSize.bar, height: controlSize.bar },
  circleLeading: { left: 0 },
  circleTrailing: { right: 0 },
  circleHit: { width: controlSize.bar, height: controlSize.bar },
  search: { flex: 1, paddingLeft: deckChromeLayout.searchLead + 3 },
  searchRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing },
  field: { flex: 1, paddingVertical: 0 },
});
