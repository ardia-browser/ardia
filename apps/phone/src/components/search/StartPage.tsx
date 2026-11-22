import { useEffect } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { measuredOr, useRootSize } from "../../state/app/rootSize";
import { openArchive, openSpaces, showDeck } from "../../state/browse/store";
import { useSearchOpen } from "../../state/search/hooks";
import { openSettings } from "../../state/settings/hooks";
import { useSyncEnabled } from "../../state/sync/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { useHasTabs, useIncognito } from "../../state/tabs/hooks";
import { chromeLayout, space, startLayout, startMotion, tabsCurve, tabsLayout, useReduceMotion, useTheme, type SymbolName } from "../ui";
import { StartCircleButton, StartPlusButton } from "./StartBarButtons";
import { StartMark, StartSpaces, startBarCenterY, type StartGeometry } from "./StartSpaces";
import { useBottomBarLayout } from "../ui/useBottomBarLayout";
import { barSpanCenter, besideStrip, DUO_BAR } from "../../lib/bottomBarSpan";
import { t } from "../../lib/uiLanguage";


export function StartPage() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { width, height } = measuredOr(useRootSize(), window);
  const trayUp = useSearchOpen();
  const incognito = useIncognito();
  const theme = useTheme();
  const dark = incognito || theme.dark;
  const reduceMotion = useReduceMotion();
  const geometry: StartGeometry = { width, height, safeSide: Math.max(insets.left, insets.right), barCenterY: startBarCenterY(height, insets.bottom) };
  const shown = useSharedValue(trayUp ? 0 : 1);
  useEffect(() => {
    shown.value = reduceMotion
      ? withTiming(trayUp ? 0 : 1, { duration: startMotion.reduced, easing: tabsCurve.easeOut })
      : withTiming(trayUp ? 0 : 1, { duration: startMotion.rise, easing: tabsCurve.depart });
  }, [trayUp, reduceMotion]);
  const contentStyle = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: reduceMotion ? 1 : startMotion.trayScale + (1 - startMotion.trayScale) * shown.value }] }), [reduceMotion]);
  const barStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const hidden = { pointerEvents: trayUp ? ("none" as const) : ("box-none" as const), importantForAccessibility: trayUp ? ("no-hide-descendants" as const) : ("auto" as const), accessibilityElementsHidden: trayUp };
  const barTop = geometry.barCenterY - startLayout.barCircle / 2;
  const { span: barSpan, strip } = useBottomBarLayout(width, chromeLayout.barSideInset);
  const plusMenuLeft = Math.min(Math.max(barSpanCenter(width, barSpan) - tabsLayout.menuWidth / 2, space.l), width - tabsLayout.menuWidth - space.l);
  const stripX = strip ? strip.centerX - DUO_BAR.button / 2 : 0;
  const leading = useStartLeading(incognito);
  const tabs = <StartCircleButton icon={leading.icon} label={leading.label} testID={leading.testID} dark={dark} incognito={incognito} onPress={leading.onPress} />;
  const plus = (
    <StartPlusButton
      width={strip ? DUO_BAR.button : startLayout.barPlus.width}
      label={incognito ? t(`New Incognito Tab`) : t(`New Tab`)}
      testID="startBarPlus"
      dark={dark}
      incognito={incognito}
      place={strip ? { bottom: height - barTop - strip.plus - DUO_BAR.button, ...besideStrip(strip, width, tabsLayout.menuWidth, space.l) } : { bottom: height - barTop + space.s, left: plusMenuLeft, width: tabsLayout.menuWidth }}
      menusShown={!trayUp}
    />
  );
  return (
    <View testID="startPage" style={StyleSheet.absoluteFill}>
      <StartSpaces geometry={geometry} dark={dark} incognito={incognito} interactive={!trayUp} />
      <Animated.View testID="startContent" {...hidden} style={[styles.mark, { paddingBottom: height - barTop }, contentStyle]}>
        <StartMark incognito={incognito} />
      </Animated.View>
      <Animated.View testID="startBar" {...hidden} style={[styles.bar, { top: barTop, paddingLeft: barSpan.left, paddingRight: barSpan.right }, strip?.ends ? styles.barEnds : null, barStyle]}>
        {strip ? null : tabs}
        {strip ? null : plus}
        <StartCircleButton icon="gearshape" label={t(`Settings`)} testID="startBarSettings" dark={dark} incognito={incognito} onPress={() => openSettings()} />
      </Animated.View>
      {strip ? (
        <>
          <Animated.View testID="startStripPlus" {...hidden} style={[styles.strip, { left: stripX, top: barTop + strip.plus }, barStyle]}>
            {plus}
          </Animated.View>
          <Animated.View testID="startStripTabs" {...hidden} style={[styles.strip, { left: stripX, top: barTop + strip.tabs }, barStyle]}>
            {tabs}
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

function useStartLeading(incognito: boolean): { icon: SymbolName; label: string; testID: string; onPress: () => void } {
  const hasTabs = useHasTabs();
  const syncs = useSyncEnabled();
  if (hasTabs) return { icon: "squareOnSquare", label: t(`Tabs`), testID: "startBarTabs", onPress: showDeck };
  const open = syncs ? openSpaces : openArchive;
  const onPress = () => {
    if (!incognito) countUsage("start_no_tabs_button_taps");
    open();
  };
  return syncs ? { icon: "laptop", label: t(`Synced Tabs`), testID: "startBarSynced", onPress } : { icon: "archivebox", label: t(`Archive`), testID: "startBarArchive", onPress };
}

const styles = StyleSheet.create({
  mark: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", left: 0, right: 0, height: startLayout.barCircle, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: startLayout.barGap },
  barEnds: { justifyContent: "flex-end" },
  strip: { position: "absolute", width: DUO_BAR.button, height: DUO_BAR.button, alignItems: "center", justifyContent: "center" },
});
