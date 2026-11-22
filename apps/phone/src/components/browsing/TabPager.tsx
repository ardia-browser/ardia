import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { incomingPose, outgoingPose, PAGER, resolvedOffset, snapTarget } from "../../lib/pagerPhysics";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { haptics } from "../../state/app/haptics";
import { usePageTone } from "../../state/browse/hooks";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { TabFace, tabsCurve, tabsLayout, tabsMotion, trayMotion, useTheme, useReduceMotion } from "../ui";

export type TabPager = {
  offset: SharedValue<number>;
  active: SharedValue<number>;
  gesture: ReturnType<typeof Gesture.Pan>;
  outgoing: ReturnType<typeof useAnimatedStyle>;
  dim: ReturnType<typeof useAnimatedStyle>;
  grab: () => boolean;
  track: (raw: number) => void;
  settleTo: (target: number, velocity: number) => void;
};

type Options = { width: number; selectedId: string | null; left: string | null; right: string | null; onCommit: (id: string) => void; onGrab: () => void };

export function useTabPager({ width, selectedId, left, right, onCommit, onGrab }: Options): TabPager {
  const reduceMotion = useReduceMotion();
  const offset = useSharedValue(0);
  const active = useSharedValue(0);
  const base = useSharedValue(0);
  const hasLeft = useSharedValue(left !== null);
  const hasRight = useSharedValue(right !== null);
  const span = useSharedValue(width);

  useEffect(() => {
    hasLeft.value = left !== null;
    hasRight.value = right !== null;
    span.value = width;
  }, [hasLeft, hasRight, left, right, span, width]);

  useEffect(() => {
    offset.value = 0;
    active.value = 0;
  }, [active, offset, selectedId]);

  const commit = (target: number) => {
    const id = target > 0 ? left : right;
    if (!id) return;
    haptics.tabLanded();
    onCommit(id);
  };

  const settleTo = (wanted: number, velocity: number) => {
    const target = (wanted > 0 && !hasLeft.value) || (wanted < 0 && !hasRight.value) ? 0 : wanted;
    const landed = (finished?: boolean) => {
      "worklet";
      if (!finished) return;
      if (target === 0) active.value = 0;
      else runOnJS(commit)(target);
    };
    offset.value = reduceMotion ? withTiming(target * span.value, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }, landed) : withSpring(target * span.value, { ...tabsMotion.pagerSettle, velocity }, landed);
  };
  const grab = () => {
    if (!hasLeft.value && !hasRight.value) return false;
    if (!active.value) onGrab();
    active.value = 1;
    return true;
  };
  const track = (raw: number) => {
    offset.value = resolvedOffset(raw, hasLeft.value, hasRight.value, span.value);
  };

  const gesture = Gesture.Pan()
    .activeOffsetX([-PAGER.minimumDistance, PAGER.minimumDistance])
    .failOffsetY([-PAGER.minimumDistance, PAGER.minimumDistance])
    .onStart(() => {
      if (!active.value) runOnJS(onGrab)();
      active.value = 1;
      base.value = offset.value;
    })
    .onUpdate((event) => {
      offset.value = resolvedOffset(base.value + event.translationX, hasLeft.value, hasRight.value, span.value);
    })
    .onEnd((event) => {
      const velocity = Math.min(Math.max(event.velocityX, -PAGER.maxVelocity), PAGER.maxVelocity);
      const target = snapTarget(offset.value, velocity, span.value, hasLeft.value, hasRight.value);
      const landed = (finished?: boolean) => {
        "worklet";
        if (!finished) return;
        if (target === 0) active.value = 0;
        else runOnJS(commit)(target);
      };
      offset.value = reduceMotion ? withTiming(target * span.value, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }, landed) : withSpring(target * span.value, { ...tabsMotion.pagerSettle, velocity }, landed);
    });

  const outgoing = useAnimatedStyle(() => {
    const pose = outgoingPose(offset.value, span.value, hasLeft.value, hasRight.value, reduceMotion);
    return { transform: [{ translateX: pose.x }, { scale: pose.scale }], borderRadius: active.value ? cornerRadius : 0 };
  });
  const dim = useAnimatedStyle(() => ({ opacity: outgoingPose(offset.value, span.value, hasLeft.value, hasRight.value, reduceMotion).dim }));

  return { offset, active, gesture, outgoing, dim, grab, track, settleTo };
}

type NeighbourProps = { pager: TabPager; tab: BrowserTab; side: -1 | 1; width: number; statusHeight: number; statusOver?: boolean; hasLeft: boolean; hasRight: boolean };

export function PagerNeighbour({ pager, tab, side, width, statusHeight, statusOver = false, hasLeft, hasRight }: NeighbourProps) {
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const { offset } = pager;
  const reduceMotion = useReduceMotion();
  const style = useAnimatedStyle(() => {
    const pose = incomingPose(side, offset.value, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.opacity, transform: [{ translateX: pose.x }] };
  });
  const shadowStyle = useAnimatedStyle(() => {
    const pose = incomingPose(side, offset.value, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.shadow, transform: [{ translateX: pose.x }] };
  });
  const shown = display(tab.url);
  const edge = side < 0 ? { left: width, experimental_backgroundImage: EDGE_SHADOW_TRAILING } : { left: -tabsLayout.pagerEdgeShadow, experimental_backgroundImage: EDGE_SHADOW_LEADING };
  return (
    <>
      <Animated.View testID="pagerEdgeShadow" pointerEvents="none" style={[styles.edge, { top: cornerRadius * 0.6, bottom: cornerRadius * 0.6 }, edge, shadowStyle]} />
      <Animated.View style={[StyleSheet.absoluteFill, styles.card, { backgroundColor: theme.surface }, style]} pointerEvents="none">
        {statusOver ? null : <View style={{ height: statusHeight, backgroundColor: tone?.top ?? theme.surface }} />}
        <View style={styles.body}>
          <TabFace tab={tab} title={tab.title || shown.host} host={shown.host} tone={tone?.top ?? null} roles={theme} />
        </View>
        {statusOver ? <View testID="pagerStatusStrip" style={[styles.statusOver, { height: statusHeight, backgroundColor: tone?.top ?? theme.pageSurface }]} /> : null}
      </Animated.View>
    </>
  );
}

const EDGE_SHADOW_STOPS = ["rgba(0,0,0,0)", "rgba(0,0,0,0.08)", "rgba(0,0,0,0.26)"];
const EDGE_SHADOW_LEADING = `linear-gradient(to right, ${EDGE_SHADOW_STOPS.join(", ")})`;
const EDGE_SHADOW_TRAILING = `linear-gradient(to left, ${EDGE_SHADOW_STOPS.join(", ")})`;

export function PagerBackdrop() {
  const theme = useTheme();
  return <View testID="pagerBackdrop" style={[StyleSheet.absoluteFill, { backgroundColor: theme.surface }]} />;
}

const cornerRadius = screenCornerRadius(tabsLayout.displayCornerRadius);

const styles = StyleSheet.create({ card: { overflow: "hidden", borderRadius: cornerRadius }, edge: { position: "absolute", width: tabsLayout.pagerEdgeShadow }, body: { flex: 1 }, statusOver: { position: "absolute", left: 0, right: 0, top: 0 } });
