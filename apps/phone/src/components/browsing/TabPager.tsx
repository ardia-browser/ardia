import { useEffect, useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { incomingPose, landedNear, outgoingPose, PAGER, resolvedOffset, snapTarget } from "../../lib/pagerPhysics";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { haptics } from "../../state/app/haptics";
import { usePageTone } from "../../state/browse/hooks";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { TabFace, tabsCurve, tabsLayout, tabsMotion, trayMotion, useTheme, useReduceMotion, smoothCorners } from "../ui";

export type TabPager = {
  offset: SharedValue<number>;
  active: SharedValue<number>;
  gesture: ReturnType<typeof Gesture.Pan>;
  outgoing: ReturnType<typeof useAnimatedStyle>;
  dim: ReturnType<typeof useAnimatedStyle>;
  grab: () => boolean;
  track: (raw: number) => void;
  settleTo: (target: number, velocity: number) => void;
  peek: (toward: -1 | 1) => boolean;
};

type Options = { width: number; selectedId: string | null; left: string | null; right: string | null; landsEarly?: boolean; onCommit: (id: string) => void; onGrab: () => void };

export function useTabPager({ width, selectedId, left, right, landsEarly = false, onCommit, onGrab }: Options): TabPager {
  const reduceMotion = useReduceMotion();
  const offset = useSharedValue(0);
  const active = useSharedValue(0);
  const base = useSharedValue(0);
  const hasLeft = useSharedValue(left !== null);
  const hasRight = useSharedValue(right !== null);
  const span = useSharedValue(width);
  const landing = useSharedValue(0);

  useEffect(() => {
    hasLeft.value = left !== null;
    hasRight.value = right !== null;
    span.value = width;
  }, [hasLeft, hasRight, left, right, span, width]);

  useLayoutEffect(() => {
    landing.value = 0;
    offset.value = 0;
    active.value = 0;
  }, [active, landing, offset, selectedId]);

  const commit = (target: number) => {
    const id = target > 0 ? left : right;
    if (!id) return;
    haptics.tabLanded();
    onCommit(id);
  };

  const land = (target: number) => {
    "worklet";
    if (landing.value !== target) return;
    landing.value = 0;
    if (target === 0) {
      active.value = 0;
      return;
    }
    runOnJS(commit)(target);
  };

  useAnimatedReaction(
    () => landsEarly && landing.value !== 0 && landedNear(offset.value, landing.value, span.value),
    (near, was) => {
      if (near && !was) land(landing.value);
    },
  );

  const settle = (target: number, velocity: number) => {
    "worklet";
    landing.value = target;
    const landed = (finished?: boolean) => {
      "worklet";
      if (finished) land(target);
    };
    offset.value = reduceMotion ? withTiming(target * span.value, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }, landed) : withSpring(target * span.value, { ...tabsMotion.pagerSettle, velocity }, landed);
  };

  const settleTo = (wanted: number, velocity: number) => {
    const target = (wanted > 0 && !hasLeft.value) || (wanted < 0 && !hasRight.value) ? 0 : wanted;
    settle(target, velocity);
  };
  const peek = (toward: -1 | 1) => {
    if (active.value || landing.value !== 0) return false;
    if (reduceMotion || (toward < 0 && !hasLeft.value) || (toward > 0 && !hasRight.value)) return true;
    active.value = 1;
    landing.value = 0;
    offset.value = withSequence(
      withTiming(-toward * PAGER.peekDistance, { duration: tabsMotion.pagerPeek, easing: tabsCurve.easeOut }),
      withSpring(0, tabsMotion.pagerSettle, (finished) => {
        "worklet";
        if (finished && landing.value === 0) active.value = 0;
      }),
    );
    return true;
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
    .withTestId("tabPager")
    .activeOffsetX([-PAGER.minimumDistance, PAGER.minimumDistance])
    .failOffsetY([-PAGER.minimumDistance, PAGER.minimumDistance])
    .onStart(() => {
      if (!active.value) runOnJS(onGrab)();
      active.value = 1;
      landing.value = 0;
      base.value = offset.value;
    })
    .onUpdate((event) => {
      offset.value = resolvedOffset(base.value + event.translationX, hasLeft.value, hasRight.value, span.value);
    })
    .onEnd((event) => {
      const velocity = Math.min(Math.max(event.velocityX, -PAGER.maxVelocity), PAGER.maxVelocity);
      settle(snapTarget(offset.value, velocity, span.value, hasLeft.value, hasRight.value), velocity);
    });

  const outgoing = useAnimatedStyle(() => {
    const pose = outgoingPose(offset.value, span.value, hasLeft.value, hasRight.value, reduceMotion);
    return { transform: [{ translateX: pose.x }, { scale: pose.scale }], borderRadius: active.value ? cornerRadius : 0 };
  });
  const dim = useAnimatedStyle(() => ({ opacity: outgoingPose(offset.value, span.value, hasLeft.value, hasRight.value, reduceMotion).dim }));

  return { offset, active, gesture, outgoing, dim, grab, track, settleTo, peek };
}

type NeighbourProps = { pager: TabPager; tab: BrowserTab; side: -1 | 0 | 1; width: number; statusHeight: number; statusOver?: boolean; hasLeft: boolean; hasRight: boolean; coverId?: string };

export function PagerNeighbour({ pager, tab, side, width, statusHeight, statusOver = false, hasLeft, hasRight, coverId }: NeighbourProps) {
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const { offset } = pager;
  const reduceMotion = useReduceMotion();
  const arrived = side === 0;
  const style = useAnimatedStyle(() => {
    if (arrived) return { opacity: 1, transform: [{ translateX: withTiming(0, { duration: tabsMotion.pagerArrive, easing: tabsCurve.easeOut }) }] };
    const pose = incomingPose(side, offset.value, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.opacity, transform: [{ translateX: pose.x }] };
  });
  const shadowStyle = useAnimatedStyle(() => {
    if (arrived) return { opacity: 0, transform: [{ translateX: 0 }] };
    const pose = incomingPose(side, offset.value, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.shadow, transform: [{ translateX: pose.x }] };
  });
  const shown = display(tab.url);
  const edge = side < 0 ? { left: width, experimental_backgroundImage: EDGE_SHADOW_TRAILING } : { left: -tabsLayout.pagerEdgeShadow, experimental_backgroundImage: EDGE_SHADOW_LEADING };
  return (
    <>
      <Animated.View testID="pagerEdgeShadow" pointerEvents="none" style={[styles.edge, { top: cornerRadius * 0.6, bottom: cornerRadius * 0.6 }, edge, shadowStyle]} />
      <Animated.View testID={arrived ? "pagerArrival" : undefined} nativeID={arrived ? coverId : undefined} collapsable={false} style={[StyleSheet.absoluteFill, styles.card, { backgroundColor: theme.canvas }, style]} pointerEvents="none">
        {statusOver ? null : <View style={{ height: statusHeight, backgroundColor: tone?.top ?? theme.canvas }} />}
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
  return <View testID="pagerBackdrop" style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }]} />;
}

const cornerRadius = screenCornerRadius(tabsLayout.displayCornerRadius);

const styles = StyleSheet.create({ card: { overflow: "hidden", borderRadius: cornerRadius, ...smoothCorners }, edge: { position: "absolute", width: tabsLayout.pagerEdgeShadow }, body: { flex: 1 }, statusOver: { position: "absolute", left: 0, right: 0, top: 0 } });
