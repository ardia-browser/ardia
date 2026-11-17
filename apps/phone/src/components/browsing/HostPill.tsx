import { useEffect, useRef, type ComponentProps } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { haptics } from "../../state/app/haptics";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { capsule, chromeInk, ChromeSurface, Favicon, floatingBarLayout, Symbol, tabsMotion, usePresence } from "../ui";
import { barAddress, spokenAddress } from "./FloatingBar";
import { hostPillLayout } from "./hostPillTokens";
import { NotSecureLock } from "./NotSecureLock";
import { useBarReturn } from "./barReturn";

const EASE_OUT = Easing.bezier(0, 0, 0.58, 1);

export function HostPill({ tab, dark, shown, anchors = false, contentStyle, onExpand }: { tab: BrowserTab; dark: boolean; shown: boolean; anchors?: boolean; contentStyle: ComponentProps<typeof Animated.View>["style"]; onExpand: () => void }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const address = barAddress(tab);
  const back = useBarReturn();
  const ids = anchors ? back.ids : null;
  const centreWas = useRef(back.centreGlass.shown);
  const centreFlips = centreWas.current !== back.centreGlass.shown;
  useEffect(() => {
    centreWas.current = back.centreGlass.shown;
  }, [back.centreGlass.shown]);
  return (
    <Animated.View testID="hostPillCentre" nativeID={ids?.anchor} collapsable={false} pointerEvents={back.centreShown ? "box-none" : "none"} importantForAccessibility={back.centreShown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!back.centreShown}>
    <ChromeSurface testID="hostPill" shape="capsule" cornerRadius={capsule(hostPillLayout.height)} incognito={tab.isPrivate} dark={dark} barShadow shown={shown && back.centreGlass.shown} shownMs={centreFlips ? back.centreGlass.shownMs : hostPillLayout.glassMs} style={styles.pill}>
      <Animated.View testID="hostPillCentreGlyphs" collapsable={false} style={back.centreGlyphs}>
      <Animated.View testID="hostPillContent" nativeID={ids?.face} collapsable={false} style={[styles.content, contentStyle]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Show Toolbar" accessibilityValue={{ text: spokenAddress(address) }} onPress={onExpand} onPressIn={haptics.barPress} style={styles.hit}>
        {address.isPrivate ? <Symbol name="eyeglassesThin" size={hostPillLayout.siteIcon * hostPillLayout.privateSymbolShare} color={ink.secondary} /> : null}
        {address.insecure ? (
          <NotSecureLock testID="hostPillNotSecure" size={hostPillLayout.siteIcon} color={ink.notSecure} />
        ) : address.isPrivate ? null : address.pageUrl ? (
          <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={hostPillLayout.siteIcon} />
        ) : null}
        <Text testID="hostPillHost" maxFontSizeMultiplier={hostPillLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
          {address.host}
        </Text>
      </Pressable>
      </Animated.View>
      </Animated.View>
    </ChromeSurface>
    </Animated.View>
  );
}

export function useBarFold(collapsed: boolean, reduceMotion: boolean) {
  const presence = usePresence(collapsed);
  const fold = useSharedValue(collapsed ? 1 : 0);
  const unmountPill = presence.hidden;
  useEffect(() => {
    const target = collapsed ? 1 : 0;
    const settled = (finished?: boolean) => {
      "worklet";
      if (finished && target === 0) runOnJS(unmountPill)();
    };
    fold.value = reduceMotion ? withTiming(target, { duration: tabsMotion.barCollapseReduced, easing: EASE_OUT }, settled) : withSpring(target, tabsMotion.barCollapse, settled);
  }, [collapsed, reduceMotion]);
  const shrink = reduceMotion ? 1 : hostPillLayout.collapsedScale;
  const bar = useAnimatedStyle(() => {
    const scale = 1 + (shrink - 1) * fold.value;
    return { opacity: 1 - fold.value, transform: [{ translateY: (floatingBarLayout.control / 2) * (1 - scale) }, { scale }] };
  }, [shrink]);
  const pill = useAnimatedStyle(() => {
    const scale = 1 / shrink + (1 - 1 / shrink) * fold.value;
    return { transform: [{ translateY: (hostPillLayout.height / 2) * (1 - scale) }, { scale }] };
  }, [shrink]);
  const pillContent = useAnimatedStyle(() => ({ opacity: fold.value }));
  return { bar, pill, pillContent, pillMounted: presence.mounted };
}

const styles = StyleSheet.create({
  pill: { maxWidth: hostPillLayout.maxWidth, height: hostPillLayout.height },
  content: { flex: 1 },
  hit: { height: hostPillLayout.height, flexDirection: "row", alignItems: "center", gap: hostPillLayout.spacing, paddingHorizontal: hostPillLayout.sideInset },
  host: { flexShrink: 1, fontSize: hostPillLayout.hostText, fontWeight: hostPillLayout.hostWeight },
});
