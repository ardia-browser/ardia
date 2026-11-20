import type { ReactNode } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
import { DECK } from "../../lib/deckGeometry";
import { pullBarGhosts, pullBarGlyphs, pullBarShift, pullClearsBar, pullPagePose, pullRise } from "../../lib/deckPull";
import { deckPull, PULL_STAGE, pullFades, setDeckOwnsBar } from "../../state/browse/deckPull";
import { tabsInk, useTheme } from "../ui";

const PULL_OFFSTAGE = 100_000;
const SHADOW_FULL_AT = 0.3;
const FADE_RISE = 100_000;
const PRIMED = 0.99;

export function PagePull({ tabId, barTop, children }: { tabId: string; barTop: number; children: ReactNode }) {
  const theme = useTheme();
  const barHanded = deckPull.barCleared;
  useAnimatedReaction(
    () => {
      const target = deckPull.target.value;
      const stage = deckPull.stage.value;
      if (stage === PULL_STAGE.idle || target === null || deckPull.id.value !== tabId) return -1;
      if (stage === PULL_STAGE.growing) return deckPull.pageLive.value ? -1 : FADE_RISE;
      if (stage === PULL_STAGE.fading) return 0;
      return pullFades(stage) ? FADE_RISE : pullRise(target, deckPull.shrink.value);
    },
    (rise) => {
      const clears = rise >= 0 && pullClearsBar(rise, barTop, barHanded.value);
      if (clears === barHanded.value) return;
      barHanded.value = clears;
      runOnJS(setDeckOwnsBar)(clears);
    },
  );
  const pose = useDerivedValue(() => {
    const target = deckPull.target.value;
    const stage = deckPull.stage.value;
    if (stage === PULL_STAGE.idle || !target || deckPull.id.value !== tabId) return null;
    if (pullFades(stage)) return { dx: 0, dy: 0, scale: 1, corner: 0, shadow: 0, seen: 1 - deckPull.fade.value };
    const shrink = deckPull.shrink.value;
    const page = pullPagePose(target, shrink);
    return { dx: page.x - target.screenWidth / 2, dy: page.y - target.screenHeight / 2, scale: page.scale, corner: page.corner / page.scale, shadow: Math.min(Math.max(shrink / SHADOW_FULL_AT, 0), 1), seen: stage === PULL_STAGE.handed || (stage === PULL_STAGE.growing && !deckPull.pageLive.value) ? 0 : stage === PULL_STAGE.growing && deckPull.steady.value ? deckPull.fade.value : 1 };
  });
  const page = useAnimatedStyle(() => {
    const p = pose.value;
    if (!p) return { opacity: deckPull.primed.value ? PRIMED : 1, borderRadius: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    return { opacity: p.seen, borderRadius: p.corner, transform: [{ translateX: p.dx }, { translateY: p.dy }, { scale: p.scale }] };
  });
  const shadow = useAnimatedStyle(() => {
    const p = pose.value;
    if (!p) return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    return { opacity: p.seen * p.shadow, transform: [{ translateX: p.dx }, { translateY: p.dy }, { scale: p.scale }] };
  });
  return (
    <>
      <Animated.View testID="pagePullShadow" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shadow, { backgroundColor: theme.surface }, shadow]} />
      <Animated.View testID="pagePull" collapsable={false} style={[StyleSheet.absoluteFill, styles.page, page]}>
        {children}
      </Animated.View>
    </>
  );
}

export function PullBlocker() {
  const style = useAnimatedStyle(() => {
    const stage = deckPull.stage.value;
    const open = stage === PULL_STAGE.idle || (stage === PULL_STAGE.growing && deckPull.pageLive.value);
    return { transform: [{ translateX: open ? PULL_OFFSTAGE : 0 }] };
  });
  return <Animated.View testID="pagePullBlocker" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, style]} />;
}

type GlyphsProps = { style?: StyleProp<ViewStyle>; children: ReactNode };

export function usePullBarShift(barTop: number, drop: number) {
  return useAnimatedStyle(() => {
    const target = deckPull.target.value;
    const stage = deckPull.stage.value;
    if (stage === PULL_STAGE.growing) return { transform: [{ translateY: drop * (deckPull.pageLive.value ? 1 - deckPull.barBack.value : 1) }] };
    const rise = stage === PULL_STAGE.idle || !target ? 0 : pullFades(stage) ? FADE_RISE : pullRise(target, deckPull.shrink.value);
    return { transform: [{ translateY: pullBarShift(rise, barTop, drop) }] };
  }, [barTop, drop]);
}

export function PullGlyphs({ style, children }: GlyphsProps) {
  const fade = useAnimatedStyle(() => {
    const target = deckPull.target.value;
    const stage = deckPull.stage.value;
    if (stage === PULL_STAGE.idle || !target) return { opacity: 1 };
    if (stage === PULL_STAGE.growing) return { opacity: deckPull.pageLive.value ? deckPull.barBack.value : 0 };
    return { opacity: pullFades(stage) ? 1 - deckPull.fade.value : pullBarGlyphs(pullRise(target, deckPull.shrink.value)) };
  });
  return (
    <Animated.View testID="pullGlyphs" pointerEvents="box-none" style={[style, fade]}>
      {children}
    </Animated.View>
  );
}

export function PullGhost({ style, children }: GlyphsProps) {
  const fade = useAnimatedStyle(() => {
    const target = deckPull.target.value;
    const stage = deckPull.stage.value;
    if (stage === PULL_STAGE.idle || !target) return { opacity: 0 };
    if (pullFades(stage)) return { opacity: deckPull.fade.value };
    if (stage === PULL_STAGE.growing) return { opacity: deckPull.pageLive.value ? 1 - deckPull.barBack.value : 1 };
    return { opacity: pullBarGhosts(pullRise(target, deckPull.shrink.value)) };
  });
  return (
    <Animated.View testID="pullGhost" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, style, fade]}>
      {children}
    </Animated.View>
  );
}

const CARD_SCALE = DECK.cardWidthRatio;

const styles = StyleSheet.create({
  page: { overflow: "hidden" },
  shadow: { borderRadius: DECK.cardRadius / CARD_SCALE, shadowColor: tabsInk.cardShadow, shadowOpacity: 1, shadowRadius: 18 / CARD_SCALE, shadowOffset: { width: -2 / CARD_SCALE, height: 4 / CARD_SCALE } },
});
