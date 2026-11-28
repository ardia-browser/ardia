import { Platform, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pageBarGhostOpacity } from "../../lib/deckGeometry";
import { pageBarDark, shownTone } from "../../lib/pageTone";
import { useNavigation, usePageTone } from "../../state/browse/hooks";
import { useDeckOrder } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { barCenterFromBottom, barHeight, browseLayout, floatingBarLayout, isDarkColor, rolesFor, useDesign, usePageUnderBars, usesGlass, useTheme } from "../ui";
import { BottomBar } from "./BottomBar";
import { FloatingBar } from "./FloatingBar";
import { MaterialBarBand } from "./MaterialPageBar";

const noop = () => undefined;

export function PageBarGhost({ tab, positionProgress, cardsOpacity }: { tab: BrowserTab; positionProgress: SharedValue<number>; cardsOpacity?: SharedValue<number> }) {
  const theme = useTheme();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const order = useDeckOrder();
  const live = usePageTone(tab.id);
  const failed = useNavigation(tab.id, (n) => n?.failure != null);
  const tone = failed ? null : shownTone(live, tab.themeColorHex);
  const redesigned = design === "redesigned";
  const bottom = tone?.bottom ?? (usePageUnderBars() ? theme.pageSurface : theme.canvas);
  const dark = pageBarDark({ design, glassTone: failed ? undefined : live?.barDark, toneBottom: tone?.bottom, themeDark: theme.dark, bottomDark: isDarkColor(bottom), incognitoLook: tab.isPrivate, os: Platform.OS, nativeGlass: usesGlass() });
  const control = redesigned ? floatingBarLayout.control : browseLayout.hitTarget;
  const style = useAnimatedStyle(() => ({ opacity: pageBarGhostOpacity(positionProgress.value) * (cardsOpacity ? cardsOpacity.value : 1) }));
  if (design === "material") {
    return (
      <Animated.View testID="pageBarGhost" pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.bar, { height: barHeight(insets.bottom, "material") }, style]}>
        <MaterialBarBand tab={tab} order={order} showsPlus safeSide={Math.max(insets.left, insets.right)} onTabs={noop} onTabsMenu={noop} onStep={noop} onAddress={noop} onPlus={noop} onMore={noop} onSiteSettings={noop} />
      </Animated.View>
    );
  }
  return (
    <Animated.View testID="pageBarGhost" pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.bar, { height: barHeight(insets.bottom, design) }, style]}>
      <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - control / 2, paddingHorizontal: Math.max(insets.left, insets.right) }]}>
        {redesigned ? (
          <FloatingBar tab={tab} order={order} roles={rolesFor(dark)} dark={dark} showsPlus anchors={false} onTabs={noop} onTabsMenu={noop} onStep={noop} onAddress={noop} onPlus={noop} onMore={noop} />
        ) : (
          <BottomBar order={order} roles={rolesFor(dark)} showsPlus onTabs={noop} onTabsMenu={noop} onStep={noop} onPlus={noop} onMore={noop} />
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
});
