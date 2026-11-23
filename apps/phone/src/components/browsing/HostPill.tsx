import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { haptics } from "../../state/app/haptics";
import { usePageBusy } from "../../state/page/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { capsule, chromeInk, chromeLayout, ChromeSurface, controlSize, Favicon, floatingBarLayout, motionAliases, pressedLook, slopToReach, Symbol, tabsMotion, useTheme } from "../ui";
import { privateMark } from "../ui/IncognitoSpecs";
import { barAddress, spokenAddress } from "./FloatingBar";
import { hostPillLayout } from "./hostPillTokens";
import { NotSecureLock } from "./NotSecureLock";
import { useBarReturn } from "./barReturn";

const REACH = slopToReach(controlSize.hitTarget, hostPillLayout.height);

export function HostPill({ tab, dark, shown, anchors = false, contentStyle, onExpand }: { tab: BrowserTab; dark: boolean; shown: boolean; anchors?: boolean; contentStyle: ComponentProps<typeof Animated.View>["style"]; onExpand: () => void }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const { rowPressed } = useTheme();
  const address = barAddress(tab);
  const busy = usePageBusy(address.tabId);
  const back = useBarReturn();
  const [pressed, setPressed] = useState(false);
  const pressIn = () => {
    setPressed(true);
    haptics.barPress();
  };
  const pressOut = () => setPressed(false);
  const glassShown = (Platform.OS === "android" || shown) && back.centreGlass.shown;
  const ids = anchors ? back.ids : null;
  const centreWas = useRef(back.centreGlass.shown);
  const centreFlips = centreWas.current !== back.centreGlass.shown;
  useEffect(() => {
    centreWas.current = back.centreGlass.shown;
  }, [back.centreGlass.shown]);
  return (
    <Animated.View testID="hostPillCentre" nativeID={ids?.anchor} collapsable={false} pointerEvents={back.centreShown ? "box-none" : "none"} importantForAccessibility={back.centreShown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!back.centreShown}>
    <Pressable testID="hostPillReach" accessible={false} importantForAccessibility="no" onPress={onExpand} onPressIn={pressIn} onPressOut={pressOut} style={styles.reach} />
    <ChromeSurface testID="hostPill" shape="capsule" cornerRadius={capsule(hostPillLayout.height)} incognito={tab.isPrivate} dark={dark} barShadow={chromeLayout.barCastsShadow && glassShown} shown={glassShown} shownMs={Platform.OS === "android" ? 0 : centreFlips ? back.centreGlass.shownMs : hostPillLayout.glassMs} style={styles.pill}>
      <Animated.View testID="hostPillCentreGlyphs" collapsable={false} style={back.centreGlyphs}>
      <Animated.View testID="hostPillContent" nativeID={ids?.face} collapsable={false} style={[styles.content, contentStyle]}>
      <Pressable testID="hostPillButton" accessibilityRole="button" accessibilityLabel="Show Toolbar" accessibilityValue={{ text: spokenAddress(address) }} accessibilityState={{ busy }} onPress={onExpand} onPressIn={pressIn} onPressOut={pressOut} style={[styles.hit, pressedLook("text", pressed, false, rowPressed)]}>
        {address.isPrivate ? <Symbol name={privateMark} size={hostPillLayout.siteIcon * hostPillLayout.privateSymbolShare} color={ink.secondary} /> : null}
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
  const android = Platform.OS === "android";
  const fold = useSharedValue(collapsed ? 1 : 0);
  useLayoutEffect(() => {
    const target = collapsed ? 1 : 0;
    fold.value = reduceMotion ? withTiming(target, { duration: android ? 0 : tabsMotion.barCollapseReduced, easing: motionAliases.hostPillEase }) : withSpring(target, tabsMotion.barCollapse);
  }, [collapsed, reduceMotion]);
  const shrink = reduceMotion ? 1 : hostPillLayout.collapsedScale;
  const bar = useAnimatedStyle(() => {
    const scale = 1 + (shrink - 1) * fold.value;
    const move = { transform: [{ translateY: (floatingBarLayout.control / 2) * (1 - scale) }, { scale }] };
    return android ? { opacity: 1 - fold.value, ...move } : move;
  }, [shrink]);
  const pill = useAnimatedStyle(() => {
    const scale = 1 / shrink + (1 - 1 / shrink) * fold.value;
    return { opacity: android ? fold.value : 1, transform: [{ translateY: (hostPillLayout.height / 2) * (1 - scale) }, { scale }] };
  }, [shrink]);
  const pillContent = useAnimatedStyle(() => ({ opacity: fold.value }));
  const barLook: BarFoldLook = { glass: android || !collapsed, glyphsGone: android ? null : fold, progress: fold };
  return { bar, barLook, pill, pillContent, pillGlass: android || collapsed, progress: fold };
}

export type BarFoldLook = { glass: boolean; glyphsGone: SharedValue<number> | null; progress: SharedValue<number> };

export function useFoldGlyphs(fold: BarFoldLook | null) {
  const gone = fold?.glyphsGone ?? null;
  return useAnimatedStyle(() => (gone ? { opacity: 1 - Math.min(Math.max(gone.value, 0), 1) } : {}), [gone]);
}

const styles = StyleSheet.create({
  pill: { maxWidth: hostPillLayout.maxWidth, height: hostPillLayout.height },
  reach: { position: "absolute", left: -REACH.left, right: -REACH.right, top: -REACH.top, bottom: -REACH.bottom },
  content: { flex: 1 },
  hit: { height: hostPillLayout.height, flexDirection: "row", alignItems: "center", gap: hostPillLayout.spacing, paddingHorizontal: hostPillLayout.sideInset },
  host: { flexShrink: 1, fontSize: hostPillLayout.hostText, fontWeight: hostPillLayout.hostWeight },
});
