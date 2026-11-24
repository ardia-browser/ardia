import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pageBarGhostOpacity } from "../../lib/deckGeometry";
import { shownTone } from "../../lib/pageTone";
import { usePageTone } from "../../state/browse/hooks";
import { useDeckOrder } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { barCenterFromBottom, barHeight, browseLayout, floatingBarLayout, isDarkColor, rolesFor, useDesign, useTheme } from "../ui";
import { BottomBar } from "./BottomBar";
import { FloatingBar } from "./FloatingBar";
import { MaterialBarBand } from "./MaterialPageBar";

const noop = () => undefined;

export function PageBarGhost({ tab, positionProgress, cardsOpacity }: { tab: BrowserTab; positionProgress: SharedValue<number>; cardsOpacity?: SharedValue<number> }) {
  const theme = useTheme();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const order = useDeckOrder();
  const tone = shownTone(usePageTone(tab.id), tab.themeColorHex);
  const redesigned = design === "redesigned";
  const dark = redesigned && !tone?.bottom ? theme.dark : isDarkColor(tone?.bottom ?? theme.canvas);
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
