import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pageBarGhostOpacity } from "../../lib/deckGeometry";
import { shownTone } from "../../lib/pageTone";
import { usePageTone } from "../../state/browse/hooks";
import { useDeckOrder } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { barCenterFromBottom, barHeight, browseLayout, isDarkColor, rolesFor, useTheme } from "../ui";
import { BottomBar } from "./BottomBar";

const noop = () => undefined;

export function PageBarGhost({ tab, positionProgress }: { tab: BrowserTab; positionProgress: SharedValue<number> }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const order = useDeckOrder();
  const tone = shownTone(usePageTone(tab.id), tab.themeColorHex);
  const dark = isDarkColor(tone?.bottom ?? theme.surface);
  const style = useAnimatedStyle(() => ({ opacity: pageBarGhostOpacity(positionProgress.value) }));
  return (
    <Animated.View testID="pageBarGhost" pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.bar, { height: barHeight(insets.bottom, "original") }, style]}>
      <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, "original") - browseLayout.hitTarget / 2, paddingHorizontal: Math.max(insets.left, insets.right) }]}>
        <BottomBar order={order} roles={rolesFor(dark)} showsPlus onTabs={noop} onTabsMenu={noop} onStep={noop} onPlus={noop} onMore={noop} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
});
