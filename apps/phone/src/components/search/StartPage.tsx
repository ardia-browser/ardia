import { useEffect } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { measuredOr, useRootSize } from "../../state/app/rootSize";
import { showDeck } from "../../state/browse/store";
import { useSearchOpen } from "../../state/search/hooks";
import { openSettings } from "../../state/settings/hooks";
import { useIncognito } from "../../state/tabs/hooks";
import { LookBackdrop, LookBackdropBase, space, startLayout, startMotion, tabsCurve, tabsLayout, useReduceMotion, useTheme } from "../ui";
import { GlassCircleButton } from "../tabs/ChromeButtons";
import { PlusMenuButton } from "../tabs/DeckBottomBar";
import { StartSpaces, startBarCenterY, type StartGeometry } from "./StartSpaces";
import { columnContentWidth } from "../../state/app/screenLayout";
import { StartColumn } from "../column/StartColumn";
import { columnContentFrame, useColumn } from "../column/SideColumn";

export function StartPage() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { width, height } = measuredOr(useRootSize(), window);
  const trayUp = useSearchOpen();
  const incognito = useIncognito();
  const theme = useTheme();
  const dark = incognito || theme.dark;
  const reduceMotion = useReduceMotion();
  const column = useColumn();
  const geometry: StartGeometry = column
    ? { width: columnContentWidth(column, width), height, safeSide: 0, barCenterY: startBarCenterY(height, insets.bottom), dotsOnBar: true }
    : { width, height, safeSide: Math.max(insets.left, insets.right), barCenterY: startBarCenterY(height, insets.bottom) };
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
  return (
    <View testID="startPage" style={StyleSheet.absoluteFill}>
      <LookBackdropBase themed={!incognito} incognito={incognito} />
      <LookBackdrop themed={!incognito} incognito={incognito} baseOutside veiled />
      <Animated.View testID="startContent" {...hidden} style={[StyleSheet.absoluteFill, column ? columnContentFrame(column, width) : null, contentStyle]}>
        <StartSpaces geometry={geometry} dark={dark} incognito={incognito} />
      </Animated.View>
      {column ? (
        <Animated.View testID="startBar" {...hidden} style={[StyleSheet.absoluteFill, barStyle]}>
          <StartColumn column={column} width={width} dark={dark} incognito={incognito} menusShown={!trayUp} />
        </Animated.View>
      ) : (
        <Animated.View testID="startBar" {...hidden} style={[styles.bar, { top: barTop, paddingHorizontal: geometry.safeSide + startLayout.barSideInset }, barStyle]}>
          <GlassCircleButton icon="squareOnSquare" label="Tabs" testID="startBarTabs" dark={dark} incognito={incognito} onPress={showDeck} />
          <PlusMenuButton
            width={startLayout.barPlus.width}
            label={incognito ? "New Incognito Tab" : "New Tab"}
            testID="startBarPlus"
            dark={dark}
            incognito={incognito}
            place={{ bottom: height - barTop + space.s, left: (width - tabsLayout.menuWidth) / 2, width: tabsLayout.menuWidth }}
            menusShown={!trayUp}
          />
          <GlassCircleButton icon="gearshape" label="Settings" testID="startBarSettings" dark={dark} incognito={incognito} onPress={() => openSettings()} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, height: startLayout.barCircle, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: startLayout.barGap },
});
