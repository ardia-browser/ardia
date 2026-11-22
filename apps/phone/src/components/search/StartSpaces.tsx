import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { redesignedBarCenterFromBottom } from "../../lib/deckGeometry";
import { linearGradientCss } from "../../lib/gradient";
import { lookForApp, type ProfileLook } from "../../lib/profileLook";
import { sfSymbol } from "../../lib/sfSymbols";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { usePreferences } from "../../state/settings/hooks";
import { useCustomTheme } from "../../state/settings/themeDraft";
import { selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import type { SyncedProfile } from "../../state/sync/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { AppIcon, browseLayout, CustomLookBackdrop, DEFAULT_PROFILE_COLOR, font, isSymbolName, PROFILE_PRESETS, rolesFor, spring, startInk, startLayout, Symbol, SystemGlyph, tabsCurve, useProfileLook, useReduceMotion, type SymbolName } from "../ui";
import { startGradient, startLogo } from "./startLook";

export type StartGeometry = { width: number; height: number; safeSide: number; barCenterY: number };

export const startBarCenterY = (height: number, safeBottom: number, os: string = Platform.OS) => height - redesignedBarCenterFromBottom(safeBottom, os);

export function StartSpaces({ geometry, dark, incognito, interactive = true }: { geometry: StartGeometry; dark: boolean; incognito: boolean; interactive?: boolean }) {
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const appLook = useProfileLook();
  const choice = usePreferences((p) => p.colorChoice);
  const custom = useCustomTheme();
  const spaces = status.isEnabled ? view.profiles : [];
  const [chosen, setChosen] = useState<string | null>(null);
  const current = (chosen ? spaces.find((p) => p.syncId === chosen) : undefined) ?? shown ?? spaces[0] ?? null;
  useEffect(() => {
    if (chosen && shown?.syncId === chosen) setChosen(null);
  }, [chosen, shown?.syncId]);
  const reduceMotion = useReduceMotion();
  const pager = useRef<FlatList<SyncedProfile>>(null);
  const index = Math.max(
    0,
    spaces.findIndex((p) => p.syncId === current?.syncId),
  );
  const pagerIndex = useRef(index);
  const pagerWidth = useRef(geometry.width);
  useEffect(() => {
    const widthChanged = pagerWidth.current !== geometry.width;
    pagerWidth.current = geometry.width;
    if (pagerIndex.current === index && !widthChanged) return;
    pagerIndex.current = index;
    pager.current?.scrollToOffset({ offset: index * geometry.width, animated: false });
  }, [index, geometry.width]);
  const looks = useMemo(() => new Map(spaces.map((space) => [space.syncId, lookForApp(choice, true, space, PROFILE_PRESETS, DEFAULT_PROFILE_COLOR, custom)])), [spaces, choice, custom]);
  const pagerLooks = useMemo(() => ({ width: geometry.width, height: geometry.height, dark, incognito, looks }), [geometry.width, geometry.height, dark, incognito, looks]);
  const select = (id: string) => {
    pagerIndex.current = spaces.findIndex((p) => p.syncId === id);
    haptics.selection();
    setChosen(id);
    selectProfile(id);
  };
  const step = (by: 1 | -1) => {
    const next = spaces[index + by];
    if (!next || next.syncId === current?.syncId) return;
    pager.current?.scrollToOffset({ offset: (index + by) * geometry.width, animated: !reduceMotion });
    if (!incognito) countUsage("spaces_picked");
    select(next.syncId);
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (geometry.width <= 0) return;
    const page = spaces[Math.round(event.nativeEvent.contentOffset.x / geometry.width)];
    if (!page || page.syncId === current?.syncId) return;
    if (!incognito) countUsage("spaces_swiped");
    select(page.syncId);
  };
  if (spaces.length > 1 && current)
    return (
      <View
        testID="startSpaces"
        style={StyleSheet.absoluteFill}
        pointerEvents={interactive ? "auto" : "none"}
        collapsable={false}
        accessibilityElementsHidden={!interactive}
        importantForAccessibility={interactive ? "auto" : "no-hide-descendants"}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Space ${index + 1} of ${spaces.length}`}
        accessibilityValue={{ text: current.name }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => step(event.nativeEvent.actionName === "increment" ? 1 : -1)}
      >
        <FlatList
          ref={pager}
          testID="startPager"
          style={StyleSheet.absoluteFill}
          data={spaces}
          keyExtractor={(space) => space.syncId}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          extraData={pagerLooks}
          getItemLayout={(_data, at) => ({ length: geometry.width, offset: geometry.width * at, index: at })}
          onMomentumScrollEnd={settle}
          renderItem={({ item }) => <StartBackdrop look={looks.get(item.syncId) ?? appLook} width={geometry.width} height={geometry.height} dark={dark} incognito={incognito} />}
        />
      </View>
    );
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <StartBackdrop look={appLook} width={geometry.width} height={geometry.height} dark={dark} incognito={incognito} />
    </View>
  );
}

function StartBackdrop({ look, width, height, dark, incognito }: { look: ProfileLook; width: number; height: number; dark: boolean; incognito: boolean }) {
  if (look.custom && !incognito) return <CustomLookBackdrop testID="startTheme" look={look} dark={dark} style={{ width, height }} />;
  return <StartGradient look={look} width={width} height={height} dark={dark} incognito={incognito} />;
}

function StartGradient({ look, width, height, dark, incognito }: { look: ProfileLook; width: number; height: number; dark: boolean; incognito: boolean }) {
  const stops = useMemo(() => startGradient(look, dark, incognito), [look, dark, incognito]);
  return <View testID="startGradient" pointerEvents="none" style={{ width, height, experimental_backgroundImage: linearGradientCss(stops, true, width, height) }} />;
}

const DRAG_REACH = 180;

export function StartMark({ incognito }: { incognito: boolean }) {
  const reduceMotion = useReduceMotion();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const lifted = useSharedValue(0);
  const pressed = useSharedValue(0);
  const settle = spring(startLogo.settle.response, startLogo.settle.damping);
  const press = spring(startLogo.press.response, startLogo.press.damping);
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(startLogo.slop)
        .onStart(() => {
          lifted.value = reduceMotion ? 0 : withSpring(1, press);
        })
        .onUpdate((event) => {
          x.value = DRAG_REACH * Math.tanh((event.translationX * startLogo.dragFollow) / DRAG_REACH);
          y.value = DRAG_REACH * Math.tanh((event.translationY * startLogo.dragFollow) / DRAG_REACH);
        })
        .onFinalize((event) => {
          if (reduceMotion) {
            x.value = withTiming(0, { duration: startLogo.reducedSettleMs, easing: tabsCurve.easeOut });
            y.value = withTiming(0, { duration: startLogo.reducedSettleMs, easing: tabsCurve.easeOut });
          } else {
            x.value = withSpring(0, { ...settle, velocity: event.velocityX * startLogo.dragFollow });
            y.value = withSpring(0, { ...settle, velocity: event.velocityY * startLogo.dragFollow });
          }
          lifted.value = reduceMotion ? 0 : withSpring(0, settle);
        }),
    [reduceMotion],
  );
  const moved = useAnimatedStyle(() => {
    const scale = reduceMotion ? 1 : 1 + (startLogo.dragLift - 1) * lifted.value - (1 - startLogo.pressScale) * pressed.value;
    const tilt = reduceMotion ? 0 : (x.value / DRAG_REACH) * startLogo.dragTilt;
    return { opacity: reduceMotion ? 1 - (1 - startLayout.logoPressOpacity) * pressed.value : 1, transform: [{ translateX: x.value }, { translateY: y.value }, { rotate: `${tilt}deg` }, { scale }] };
  }, [reduceMotion]);
  const search = () => {
    if (Platform.OS === "android" && !incognito) countUsage("start_logo_taps");
    newTab();
  };
  return (
    <GestureDetector gesture={drag}>
      <Animated.View testID="startLogo" collapsable={false} style={moved}>
        <Pressable
          testID="startLogoButton"
          accessibilityRole="button"
          accessibilityLabel="Search"
          accessibilityHint="Opens Search."
          onPressIn={() => {
            haptics.barPress();
            pressed.value = reduceMotion ? withTiming(1, { duration: startLogo.reducedSettleMs / 2 }) : withSpring(1, press);
          }}
          onPressOut={() => {
            pressed.value = reduceMotion ? withTiming(0, { duration: startLogo.reducedSettleMs }) : withSpring(0, settle);
          }}
          onPress={search}
          style={styles.logoButton}
        >
          <AppIcon side={startLogo.iconSide} shadow scalesWithText={false} />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

export function SpaceTitle({ space: profile, dark, showsChevron }: { space: SyncedProfile; dark: boolean; showsChevron: boolean }) {
  const roles = rolesFor(dark);
  return (
    <View style={styles.title}>
      <SpaceGlyph space={profile} dark={dark} />
      <Text style={[font.body, styles.headline, { color: roles.headerText }]} numberOfLines={1}>
        {profile.name}
      </Text>
      {showsChevron ? <SystemGlyph testID="spaceTitleChevron" systemName="chevron.down" pointSize={12} weight="semibold" fitted name="chevronDown" size={startLayout.chevron} color={roles.secondaryLabel} /> : null}
    </View>
  );
}

function SpaceGlyph({ space: profile, dark }: { space: SyncedProfile; dark: boolean }) {
  const ink = dark ? startInk.dark : startInk.light;
  const size = startLayout.spaceBadge;
  const symbol = symbolOf(profile.icon);
  if (symbol)
    return (
      <View testID="startSpaceGlyph" style={[styles.centered, { width: size * startLayout.badgeSymbolWidth, height: size }]}>
        <Symbol name={symbol} size={size * startLayout.badgeSymbolShare} color={ink.badgeInk} />
      </View>
    );
  const emoji = emojiOf(profile.icon);
  if (!emoji) return null;
  return (
    <View testID="startSpaceGlyph" style={[styles.centered, { width: size, height: size }]}>
      <Text style={{ fontSize: size * startLayout.badgeEmojiShare }}>{emoji}</Text>
    </View>
  );
}

function symbolOf(icon: string | null): SymbolName | null {
  const symbol = sfSymbol(icon, isSymbolName);
  return symbol && isSymbolName(symbol) ? symbol : null;
}

export function spaceMenuSymbol(profile: SyncedProfile): SymbolName | null {
  return symbolOf(profile.icon);
}

export function emojiOf(icon: string | null): string | null {
  if (!icon || [...icon].length > 2 || !/\p{Emoji_Presentation}/u.test(icon)) return null;
  return icon;
}

const styles = StyleSheet.create({
  title: { flexDirection: "row", alignItems: "center", gap: startLayout.titleSpacing, minHeight: browseLayout.hitTarget },
  headline: { fontWeight: "600" },
  logoButton: { alignItems: "center", justifyContent: "center" },
  centered: { alignItems: "center", justifyContent: "center" },
});
