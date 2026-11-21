import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { newIncognitoTab, newRegularTab, newTab, openArchive, openSpaces, reopenLastClosed, showDeck } from "../../state/browse/store";
import { useSyncEnabled } from "../../state/sync/hooks";
import { useSearchOpen } from "../../state/search/hooks";
import { useCanReopen, useHasTabs, useIncognito } from "../../state/tabs/hooks";
import { ArdiaLogo, browseLayout, deckCenterFromBottom, FrostSource, iPhoneOr, LookBackdrop, LookBackdropBase, Menu, moveTo, tabsCurve, tabsLayout, trayMotion, type MenuItem, useDesign, useReduceMotion } from "../ui";
import { openSettings } from "../../state/settings/hooks";
import { DeckBar } from "../tabs/DeckBar";
import { MaterialStart } from "./MaterialStart";
import { StartPage } from "./StartPage";

const BAR_RESERVE = 58;

export function StartScreen() {
  const design = useDesign();
  if (design === "material") return <MaterialStart />;
  return design === "redesigned" ? <StartPage /> : <OriginalStart />;
}

function OriginalStart() {
  const insets = useSafeAreaInsets();
  const trayUp = useSearchOpen();
  const hasTabs = useHasTabs();
  const incognito = useIncognito();
  const canReopen = useCanReopen();
  const { width } = useWindowDimensions();
  const syncs = useSyncEnabled();
  const reduceMotion = useReduceMotion();
  const [menu, setMenu] = useState(false);
  const center = deckCenterFromBottom(insets.bottom);
  const shown = useSharedValue(trayUp ? 0 : 1);
  useEffect(() => {
    shown.value = reduceMotion
      ? withTiming(trayUp ? 0 : 1, { duration: trayMotion.reduced, easing: tabsCurve.easeInOut })
      : moveTo(trayUp ? 0 : 1, trayMotion.rise);
  }, [trayUp, reduceMotion]);
  const logoStyle = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: reduceMotion ? 1 : 0.92 + 0.08 * shown.value }] }), [reduceMotion]);
  const barStyle = useAnimatedStyle(() => ({ opacity: BAR_STAYS_UNDER_TRAY ? 1 : shown.value }));
  const leading = hasTabs
    ? { icon: "squareOnSquare" as const, label: "Tabs", onPress: showDeck }
    : syncs
      ? { icon: "laptop" as const, label: "Synced Tabs", onPress: openSpaces }
      : { icon: "archivebox" as const, label: "Archive", onPress: openArchive };
  const items: MenuItem[] = incognito
    ? [
        { label: "New Tab", icon: "plus", onPress: newRegularTab },
        { label: "New Incognito Tab", icon: "eyeglassesThin", onPress: newTab },
      ]
    : [
        { label: "New Incognito Tab", icon: "eyeglassesThin", onPress: newIncognitoTab },
        ...(canReopen ? [{ label: "Reopen Closed Tab", icon: "arrowUturnBackward" as const, onPress: reopenLastClosed }] : []),
      ];
  return (
    <View style={StyleSheet.absoluteFill}>
      <LookBackdropBase themed={!incognito} incognito={incognito} />
      <FrostSource name={START_FROST} style={StyleSheet.absoluteFill} pointerEvents="none">
        <LookBackdrop themed={!incognito} incognito={incognito} baseOutside />
      </FrostSource>
      <View style={[styles.logo, { paddingBottom: BAR_RESERVE / 2 }]} pointerEvents="none" importantForAccessibility={trayUp ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={trayUp}>
        <Animated.View style={logoStyle}>
          <ArdiaLogo width={browseLayout.logoWidth} />
        </Animated.View>
      </View>
      <Animated.View
        testID="startDeckBar"
        pointerEvents={trayUp ? "none" : "box-none"} collapsable={false}
        importantForAccessibility={trayUp ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={trayUp}
        style={[styles.deck, { bottom: center - browseLayout.hitTarget / 2, paddingHorizontal: tabsLayout.barSideInset - 4 }, barStyle]}
      >
        <DeckBar
            leading={leading}
            plusLabel={incognito ? "New Incognito Tab" : "New Tab"}
            frost={{ source: START_FROST, variant: "glass", incognito }}
            covered={trayUp}
            onPlus={newTab}
            onPlusMenu={() => setMenu(true)}
            onSettings={() => openSettings()}
          />
      </Animated.View>
      {menu && !trayUp ? (
        <Menu
          items={items}
          place={{ bottom: center + tabsLayout.barPlus.height, left: (width - tabsLayout.menuWidth) / 2, width: tabsLayout.menuWidth }}
          onDismiss={() => setMenu(false)}
        />
      ) : null}
    </View>
  );
}

const START_FROST = "start";
const BAR_STAYS_UNDER_TRAY = iPhoneOr(false, true);

const styles = StyleSheet.create({
  logo: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  deck: { position: "absolute", left: 0, right: 0 },
});
