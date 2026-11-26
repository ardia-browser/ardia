import { probes } from "../../state/app/launchFlags";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, runOnJS, runOnUI, useAnimatedProps, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { incomingPose, landedNear, outgoingPose, PAGER, resolvedOffset, snapTarget } from "../../lib/pagerPhysics";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { haptics } from "../../state/app/haptics";
import { usePageTone } from "../../state/browse/hooks";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { tabSwitchCuts } from "../../state/browse/tabSwitch";
import { currentTabs } from "../../state/tabs/store";
import { findTab } from "../../state/tabs/tabsState";
import { labTrace, traceSlice } from "../../platform/lab";
import { carryHeldBarAction, commitBarAction, dropBarAction, takeBarAction, type BarAction } from "../../state/browse/store";
import { useWarmPicture } from "../../state/tabs/warmPictures";
import { TabFace, tabsCurve, tabsLayout, tabsMotion, trayMotion, useTheme, useReduceMotion, smoothCorners } from "../ui";
import { UiFrameMark, uiFrameMarkStyle } from "../ui/UiFrameMark";

export type TabPager = {
  offset: SharedValue<number>;
  from: SharedValue<string>;
  active: SharedValue<number>;
  cursor: SharedValue<string>;
  landed: SharedValue<string>;
  turn: SharedValue<number>;
  panning: SharedValue<number>;
  travel: SharedValue<number>;
  rendered: string;
  renderedLeft: string;
  renderedRight: string;
  gesture: ReturnType<typeof Gesture.Pan>;
  outgoing: ReturnType<typeof useAnimatedStyle>;
  dim: ReturnType<typeof useAnimatedStyle>;
  grab: () => boolean;
  track: (raw: number) => void;
  settleTo: (target: number, velocity: number) => void;
  peek: (toward: -1 | 1) => boolean;
  validates: (from: string, to: string) => boolean;
  landedTarget: () => string | null;
  landedScope: () => string;
  refusedTurn: SharedValue<number>;
};

export type SwipeRefusal = "edge" | "short" | "opposed" | "cancelled";

export function landedFaceShown(side: -1 | 0 | 1, at: number, width: number): boolean {
  "worklet";
  return side !== 0 && width > 0 && Math.abs(at + side * width) < 1;
}

export function refusedMark(turn: number): string {
  "worklet";
  return turn > 0 ? `swipe-zero:${turn}` : "";
}

export function restOf(cursor: string, from: string, left: string, right: string, span: number): number | null {
  "worklet";
  if (cursor === from) return 0;
  if (cursor !== "" && cursor === left) return span;
  if (cursor !== "" && cursor === right) return -span;
  return null;
}

export function settledOffset(from: string, owner: string, cursor: string, at: number, ownerLeft: string, ownerRight: string, span: number): number {
  "worklet";
  if (from === owner) return at;
  return restOf(cursor, owner, ownerLeft, ownerRight, span) ?? 0;
}

export function heldPose(rest: number, travel: number, span: number): number {
  "worklet";
  if (rest === 0) return 0;
  if (rest > 0) return Math.min(Math.max(rest + travel, 0), span);
  return Math.max(Math.min(rest + travel, 0), -span);
}

export function besideIn(order: readonly string[], id: string, delta: -1 | 1): string {
  "worklet";
  const at = order.indexOf(id);
  if (at < 0) return "";
  return order[at + delta] ?? "";
}

export function swipeRefusal(candidate: string, projected: number, span: number): SwipeRefusal {
  "worklet";
  if (candidate === "") return "edge";
  if (Math.abs(projected) <= span * PAGER.commitFraction) return "short";
  return "opposed";
}

export function adjacentIn(order: readonly string[], from: string, to: string): boolean {
  const at = order.indexOf(from);
  return at >= 0 && to !== "" && (order[at - 1] === to || order[at + 1] === to);
}

type Options = { width: number; selectedId: string | null; left: string | null; right: string | null; order?: readonly string[]; landsEarly?: boolean; onCommit: (id: string, onScreen: boolean) => void; onHeld?: (id: string, action: BarAction) => void; onSequence?: (active: boolean) => void; onGrab: () => void };

export function isOpenTab(id: string): boolean {
  const tabs = currentTabs();
  return id !== "" && (tabs.open.some((tab) => tab.id === id) || tabs.privates.some((tab) => tab.id === id));
}

export function useTabPager({ width, selectedId, left, right, order, landsEarly = false, onCommit, onHeld, onSequence, onGrab }: Options): TabPager {
  const reduceMotion = useReduceMotion();
  const cuts = tabSwitchCuts();
  const shownId = selectedId ?? "";
  const line = useMemo(() => order ?? [left ?? "", shownId, right ?? ""].filter(Boolean), [order, left, shownId, right]);
  const offset = useSharedValue(0);
  const active = useSharedValue(0);
  const panning = useSharedValue(0);
  const catching = useSharedValue(0);
  const base = useSharedValue(0);
  const travel = useSharedValue(0);
  const hasLeft = useSharedValue(left !== null);
  const hasRight = useSharedValue(right !== null);
  const span = useSharedValue(width);
  const landing = useSharedValue(0);
  const landingTurn = useSharedValue(0);
  const fromId = useSharedValue(shownId);
  const leftId = useSharedValue(left ?? "");
  const rightId = useSharedValue(right ?? "");
  const lineIds = useSharedValue<readonly string[]>(line);
  const cursor = useSharedValue(shownId);
  const landed = useSharedValue("");
  const source = useSharedValue(shownId);
  const latchedLeft = useSharedValue(left ?? "");
  const latchedRight = useSharedValue(right ?? "");
  const turn = useSharedValue(0);
  const cursorTurn = useSharedValue(0);
  const ackedTurn = useSharedValue(0);
  const refusedTurn = useSharedValue(0);
  const panStarts = useSharedValue(0);
  const committedTurn = useRef(0);
  const lineRef = useRef(line);
  lineRef.current = line;
  const mountedPage = useRef(shownId);
  useLayoutEffect(() => {
    mountedPage.current = shownId;
  }, [shownId]);

  const latchFromCursor = () => {
    "worklet";
    const at = cursor.value;
    source.value = at;
    const rendered = at === fromId.value;
    latchedLeft.value = rendered ? leftId.value : besideIn(lineIds.value, at, -1);
    latchedRight.value = rendered ? rightId.value : besideIn(lineIds.value, at, 1);
  };

  const rebase = (shown: string, l: string, r: string, ids: readonly string[], w: number) => {
    "worklet";
    const moved = shown !== fromId.value;
    fromId.value = shown;
    leftId.value = l;
    rightId.value = r;
    hasLeft.value = l !== "";
    hasRight.value = r !== "";
    lineIds.value = ids;
    span.value = w;
    const inFlight = cursorTurn.value > ackedTurn.value;
    const followed = moved && !inFlight && cursor.value !== shown;
    if (followed) cursor.value = shown;
    if (!inFlight) landed.value = "";
    if (!moved) return;
    if (panning.value) {
      catching.value = 0;
      if (followed) latchFromCursor();
      const rest = restOf(cursor.value, shown, l, r, w);
      if (rest === null) return;
      offset.value = rest === 0 ? resolvedOffset(travel.value, l !== "", r !== "", w) : heldPose(rest, travel.value, w);
      return;
    }
    cancelAnimation(offset);
    landing.value = 0;
    const rest = restOf(cursor.value, shown, l, r, w);
    if (rest !== null) offset.value = rest;
    active.value = cursor.value !== shown ? 1 : 0;
  };

  const settledShown = useRef(shownId);
  useLayoutEffect(() => {
    if (cuts) {
      runOnUI(rebase)(shownId, left ?? "", right ?? "", line, width);
      return;
    }
    const moved = settledShown.current !== shownId;
    settledShown.current = shownId;
    fromId.value = shownId;
    leftId.value = left ?? "";
    rightId.value = right ?? "";
    hasLeft.value = left !== null;
    hasRight.value = right !== null;
    lineIds.value = line;
    span.value = width;
    if (!moved) return;
    panStarts.value += 1;
    cursor.value = shownId;
    landed.value = "";
    landing.value = 0;
    offset.value = 0;
    active.value = 0;
  }, [shownId, left, right, line, width]);

  const acknowledge = (lift: number) => {
    "worklet";
    if (lift > ackedTurn.value) ackedTurn.value = lift;
    if (cursorTurn.value <= ackedTurn.value) landed.value = "";
  };

  const restore = () => {
    runOnUI(() => {
      "worklet";
      cursor.value = fromId.value;
      landed.value = "";
      if (panning.value) {
        catching.value = 0;
        latchFromCursor();
        return;
      }
      cancelAnimation(offset);
      landing.value = 0;
      offset.value = 0;
      active.value = 0;
    })();
  };

  const validates = (from: string, to: string) => {
    const tabs = currentTabs();
    return Boolean(to) && tabs.selectedId === from && isOpenTab(to) && adjacentIn(lineRef.current, from, to);
  };

  const logSwipe = (verdict: "accepted" | "refused", lift: number, from: string, candidate: string, projected: number, reason: string) => {
    labTrace(`PAGELAB swipe ${verdict} turn=${lift} source=${from || "none"} candidate=${candidate || "none"} projected=${Math.round(projected)} reason=${reason}`);
    traceSlice(`swipe ${verdict}:${reason}:${lift}`);
    if (verdict === "refused") settleSequence();
  };

  const beginSequence = () => onSequence?.(true);
  const settleSequence = () => {
    if (panning.value || cursorTurn.value > committedTurn.current) return;
    onSequence?.(false);
  };

  const commit = (from: string, to: string, lift: number, starts: number) => {
    commitLift(from, to, lift, starts);
    settleSequence();
  };

  const commitLift = (from: string, to: string, lift: number, starts: number) => {
    if (lift > committedTurn.current) committedTurn.current = lift;
    runOnUI(acknowledge)(lift);
    if (!cuts && starts !== panStarts.value) {
      dropBarAction(swipeScope(lift));
      return;
    }
    const later = cursorTurn.value > lift;
    if (!validates(from, to)) {
      const tabs = currentTabs();
      const reason = tabs.selectedId !== from ? "stale-source" : !isOpenTab(to) ? (findTab(tabs, to) ? "archived" : "closed") : "not-neighbour";
      logSwipe("refused", lift, from, to, 0, reason);
      dropBarAction(swipeScope(lift));
      if (!later) restore();
      return;
    }
    traceSlice("swipe commit");
    haptics.tabLanded();
    const onScreen = to === mountedPage.current;
    if (later) {
      carryHeldBarAction(() => onCommit(to, onScreen));
      return;
    }
    const held = takeBarAction(swipeScope(lift), to);
    onCommit(to, onScreen);
    if (!held || currentTabs().selectedId !== to) return;
    if (onScreen && onHeld) onHeld(to, held);
    else commitBarAction(to, held);
  };

  const landedScope = () => swipeScope(cursorTurn.value);
  const landedTarget = () => {
    const pending = cursorTurn.value;
    if (pending <= committedTurn.current) return null;
    const at = cursor.value;
    if (!cuts && at === fromId.value) return null;
    return at || null;
  };

  const advance = (to: string, lift: number, from: string) => {
    "worklet";
    cursor.value = to;
    landed.value = to;
    cursorTurn.value = lift;
    runOnJS(commit)(from, to, lift, panStarts.value);
  };

  const land = (target: number) => {
    "worklet";
    if (landing.value !== target) return;
    landing.value = 0;
    if (target === 0) {
      if (!panning.value) active.value = cursor.value !== fromId.value ? 1 : 0;
      return;
    }
    advance(target > 0 ? latchedLeft.value : latchedRight.value, landingTurn.value, source.value);
  };

  useAnimatedReaction(
    () => landsEarly && landing.value !== 0 && landedNear(offset.value, landing.value, span.value),
    (near, was) => {
      if (near && !was) land(landing.value);
    },
  );

  const springTo = (at: number, velocity: number, landed?: (finished?: boolean) => void) => {
    "worklet";
    offset.value = reduceMotion ? withTiming(at, { duration: trayMotion.reduced, easing: tabsCurve.easeOut }, landed) : withSpring(at, { ...tabsMotion.pagerSettle, velocity }, landed);
  };

  const zeroAt = (lift: number) => {
    "worklet";
    const rest = restOf(cursor.value, fromId.value, leftId.value, rightId.value, span.value);
    if (rest !== null) offset.value = rest;
    refusedTurn.value = lift;
    active.value = cursor.value !== fromId.value ? 1 : 0;
  };

  const settleCaught = (target: number, velocity: number, lift: number) => {
    "worklet";
    landing.value = target;
    landingTurn.value = lift;
    if (cuts && target !== 0) {
      offset.value = target * span.value;
      land(target);
      return;
    }
    if (cuts) {
      landing.value = 0;
      zeroAt(lift);
      return;
    }
    springTo(target * span.value, velocity, (finished?: boolean) => {
      "worklet";
      if (finished) land(target);
    });
  };

  const settleFromCursor = (target: number, velocity: number, lift: number) => {
    "worklet";
    landing.value = 0;
    if (target === 0) {
      if (cuts) {
        zeroAt(lift);
        return;
      }
      const rest = restOf(cursor.value, fromId.value, leftId.value, rightId.value, span.value);
      if (rest !== null)
        springTo(rest, velocity, (finished?: boolean) => {
          "worklet";
          if (finished && !panning.value) active.value = cursor.value !== fromId.value ? 1 : 0;
        });
      return;
    }
    const from = source.value;
    const to = target > 0 ? latchedLeft.value : latchedRight.value;
    const rest = restOf(to, fromId.value, leftId.value, rightId.value, span.value);
    if (rest !== null) {
      if (cuts) offset.value = rest;
      else springTo(rest, velocity);
    }
    active.value = 1;
    advance(to, lift, from);
  };

  const settleTo = (wanted: number, velocity: number) => {
    const target = (wanted > 0 && !hasLeft.value) || (wanted < 0 && !hasRight.value) ? 0 : wanted;
    turn.value += 1;
    panning.value = 0;
    catching.value = 0;
    settleCaught(target, velocity, turn.value);
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
    catching.value = 1;
    source.value = fromId.value;
    latchedLeft.value = leftId.value;
    latchedRight.value = rightId.value;
    return true;
  };
  const track = (raw: number) => {
    offset.value = resolvedOffset(raw, hasLeft.value, hasRight.value, span.value);
  };

  const gesture = Gesture.Pan()
    .withTestId("tabPager")
    .activeOffsetX([-PAGER.minimumDistance, PAGER.minimumDistance])
    .failOffsetY([-PAGER.minimumDistance, PAGER.minimumDistance])
    .onBegin(() => {
      runOnJS(beginSequence)();
    })
    .onFinalize(() => {
      runOnJS(settleSequence)();
    })
    .onStart(() => {
      if (!active.value) runOnJS(onGrab)();
      active.value = 1;
      panning.value = 1;
      travel.value = 0;
      landing.value = 0;
      if (!cuts) {
        panStarts.value += 1;
        cursor.value = fromId.value;
        landed.value = "";
        catching.value = 1;
        base.value = offset.value;
        latchFromCursor();
        return;
      }
      catching.value = 0;
      base.value = 0;
      latchFromCursor();
    })
    .onUpdate((event) => {
      travel.value = event.translationX;
      if (catching.value) {
        offset.value = resolvedOffset(base.value + event.translationX, hasLeft.value, hasRight.value, span.value);
        return;
      }
      const rest = restOf(cursor.value, fromId.value, leftId.value, rightId.value, span.value);
      if (rest === null) return;
      offset.value = rest === 0 ? resolvedOffset(event.translationX, hasLeft.value, hasRight.value, span.value) : heldPose(rest, event.translationX, span.value);
    })
    .onEnd((event, success) => {
      panning.value = 0;
      turn.value += 1;
      const lift = turn.value;
      const caught = catching.value === 1;
      catching.value = 0;
      const from = source.value;
      if (!success) {
        runOnJS(logSwipe)("refused", lift, from, "", 0, "cancelled");
        if (caught && !cuts) settleCaught(0, 0, lift);
        else settleFromCursor(0, 0, lift);
        return;
      }
      const velocity = Math.min(Math.max(event.velocityX, -PAGER.maxVelocity), PAGER.maxVelocity);
      const towardLeft = latchedLeft.value !== "";
      const towardRight = latchedRight.value !== "";
      const at = caught ? offset.value : resolvedOffset(travel.value, towardLeft, towardRight, span.value);
      const target = caught ? snapTarget(at, velocity, span.value, hasLeft.value, hasRight.value) : snapTarget(at, velocity, span.value, towardLeft, towardRight);
      const projected = at + velocity * PAGER.projectionTime;
      const candidate = projected > 0 ? latchedLeft.value : projected < 0 ? latchedRight.value : "";
      if (target === 0) runOnJS(logSwipe)("refused", lift, from, candidate, projected, swipeRefusal(candidate, projected, span.value));
      else runOnJS(logSwipe)("accepted", lift, from, target > 0 ? latchedLeft.value : latchedRight.value, projected, "accepted");
      if (caught) settleCaught(target, velocity, lift);
      else settleFromCursor(target, velocity, lift);
    });

  const renderedLeft = left ?? "";
  const renderedRight = right ?? "";
  const outgoing = useAnimatedStyle(() => {
    const at = settledOffset(fromId.value, shownId, cursor.value, offset.value, renderedLeft, renderedRight, span.value);
    const pose = outgoingPose(at, span.value, renderedLeft !== "", renderedRight !== "", reduceMotion);
    return { transform: [{ translateX: pose.x }, { scale: pose.scale }], borderRadius: active.value ? cornerRadius : 0 };
  });
  const dim = useAnimatedStyle(() => {
    const at = settledOffset(fromId.value, shownId, cursor.value, offset.value, renderedLeft, renderedRight, span.value);
    return { opacity: outgoingPose(at, span.value, renderedLeft !== "", renderedRight !== "", reduceMotion).dim };
  });

  return { offset, from: fromId, active, cursor, landed, turn, panning, travel, rendered: shownId, renderedLeft, renderedRight, gesture, outgoing, dim, grab, track, settleTo, peek, validates, landedTarget, landedScope, refusedTurn };
}

type NeighbourProps = { pager: TabPager; tab: BrowserTab; side: -1 | 0 | 1; width: number; statusHeight: number; statusOver?: boolean; hasLeft: boolean; hasRight: boolean; coverId?: string };

export function PagerNeighbour({ pager, tab, side, width, statusHeight, statusOver = false, hasLeft, hasRight, coverId }: NeighbourProps) {
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const { offset, from, cursor, rendered, renderedLeft, renderedRight } = pager;
  const reduceMotion = useReduceMotion();
  const cuts = tabSwitchCuts();
  const arrived = side === 0;
  const style = useAnimatedStyle(() => {
    const at = settledOffset(from.value, rendered, cursor.value, offset.value, renderedLeft, renderedRight, width);
    if (arrived && cuts) {
      const pose = outgoingPose(at, width, hasLeft, hasRight, reduceMotion);
      return { opacity: 1, transform: [{ translateX: pose.x }, { scale: pose.scale }] };
    }
    if (arrived) return { opacity: 1, transform: [{ translateX: withTiming(0, { duration: tabsMotion.pagerArrive, easing: tabsCurve.easeOut }) }] };
    const pose = incomingPose(side, at, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.opacity, transform: [{ translateX: pose.x }] };
  });
  const shadowStyle = useAnimatedStyle(() => {
    if (arrived) return { opacity: 0, transform: [{ translateX: 0 }] };
    const at = settledOffset(from.value, rendered, cursor.value, offset.value, renderedLeft, renderedRight, width);
    const pose = incomingPose(side, at, width, hasLeft, hasRight, reduceMotion);
    return { opacity: pose.shadow, transform: [{ translateX: pose.x }] };
  });
  const shown = display(tab.url);
  const viewport = useWindowDimensions();
  const warm = useWarmPicture(tab, viewport, cuts && !probes("warm"));
  const faceTab = cuts && !warm && tab.snapshotFileName ? { ...tab, snapshotFileName: null } : tab;
  const faceShown = useAnimatedStyle(() => {
    const at = settledOffset(from.value, rendered, cursor.value, offset.value, renderedLeft, renderedRight, width);
    return { opacity: landedFaceShown(side, at, width) ? 1 : 0 };
  });
  const edge = side < 0 ? { left: width, experimental_backgroundImage: EDGE_SHADOW_TRAILING } : { left: -tabsLayout.pagerEdgeShadow, experimental_backgroundImage: EDGE_SHADOW_LEADING };
  return (
    <>
      <Animated.View testID="pagerEdgeShadow" pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.edge, { top: cornerRadius * 0.6, bottom: cornerRadius * 0.6 }, edge, shadowStyle]} />
      <Animated.View testID={arrived ? "pagerArrival" : undefined} nativeID={arrived ? coverId : undefined} collapsable={false} style={[StyleSheet.absoluteFill, styles.card, { backgroundColor: theme.canvas }, style]} pointerEvents={arrived && cuts && !warm ? "auto" : "none"} importantForAccessibility={"no-hide-descendants"} accessibilityElementsHidden={true}>
        {statusOver ? null : <View style={{ height: statusHeight, backgroundColor: tone?.top ?? theme.canvas }} />}
        <View style={styles.body}>
          <TabFace tab={faceTab} title={tab.title || shown.host} host={shown.host} tone={tone?.top ?? null} roles={theme} />
        </View>
        {warm ? <Image testID="pagerWarmPicture" source={{ uri: warm.uri }} fadeDuration={0} style={[styles.warm, { left: warm.frame.x, top: warm.frame.y, width: warm.frame.width, height: warm.frame.height }]} /> : null}
        {statusOver ? <View testID="pagerStatusStrip" style={[styles.statusOver, { height: statusHeight, backgroundColor: tone?.top ?? theme.pageSurface }]} /> : null}
        {cuts && !arrived ? <UiFrameMark testID="pagerFaceMark" markWhenShown={`dest-face:${tab.id}`} style={[uiFrameMarkStyle, faceShown]} /> : null}
      </Animated.View>
    </>
  );
}

export function aheadPose(side: -1 | 1, id: string, inner: string, cursor: string, panning: number, travel: number, width: number): { shown: boolean; x: number } {
  "worklet";
  if (cursor === id) return { shown: true, x: 0 };
  if (panning !== 0 && cursor === inner && side * travel < 0) return { shown: true, x: side > 0 ? Math.max(0, width + travel) : Math.min(0, travel - width) };
  return { shown: false, x: side * width };
}

type AheadProps = { pager: TabPager; tab: BrowserTab; side: -1 | 1; inner: string; width: number; statusHeight: number; statusOver?: boolean };

export function PagerAhead({ pager, tab, side, inner, width, statusHeight, statusOver = false }: AheadProps) {
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const { cursor, panning, travel } = pager;
  const style = useAnimatedStyle(() => {
    const pose = aheadPose(side, tab.id, inner, cursor.value, panning.value, travel.value, width);
    return { opacity: pose.shown ? 1 : 0, transform: [{ translateX: pose.x }] };
  }, [side, tab.id, inner, width]);
  const faceShown = useAnimatedStyle(() => ({ opacity: cursor.value === tab.id ? 1 : 0 }), [tab.id]);
  const shown = display(tab.url);
  const face = tab.snapshotFileName ? { ...tab, snapshotFileName: null } : tab;
  return (
    <Animated.View testID="pagerAhead" collapsable={false} style={[StyleSheet.absoluteFill, styles.card, { backgroundColor: theme.canvas }, style]} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {statusOver ? null : <View style={{ height: statusHeight, backgroundColor: tone?.top ?? theme.canvas }} />}
      <View style={styles.body}>
        <TabFace tab={face} title={tab.title || shown.host} host={shown.host} tone={tone?.top ?? null} roles={theme} />
      </View>
      {statusOver ? <View style={[styles.statusOver, { height: statusHeight, backgroundColor: tone?.top ?? theme.pageSurface }]} /> : null}
      <UiFrameMark testID="pagerAheadMark" markWhenShown={`dest-face:${tab.id}`} style={[uiFrameMarkStyle, faceShown]} />
    </Animated.View>
  );
}

const EDGE_SHADOW_STOPS = ["rgba(0,0,0,0)", "rgba(0,0,0,0.08)", "rgba(0,0,0,0.26)"];
const EDGE_SHADOW_LEADING = `linear-gradient(to right, ${EDGE_SHADOW_STOPS.join(", ")})`;
const EDGE_SHADOW_TRAILING = `linear-gradient(to left, ${EDGE_SHADOW_STOPS.join(", ")})`;

const swipeScope = (turn: number) => `swipe:${turn}`;

export function zeroArmedTurn(turn: number, refused: number, panning: number): number {
  "worklet";
  return panning === 0 && refused > 0 && refused === turn ? turn : turn + 1;
}

export function PagerBackdrop({ pager }: { pager?: TabPager }) {
  const theme = useTheme();
  return (
    <View testID="pagerBackdrop" style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }]}>
      {pager && tabSwitchCuts() ? <PagerMarks pager={pager} /> : null}
    </View>
  );
}

function PagerMarks({ pager }: { pager: TabPager }) {
  const { refusedTurn, turn, panning, landed, from, offset, rendered } = pager;
  const zeroArmed = useAnimatedProps(() => {
    const now = turn.value;
    const refused = refusedTurn.value;
    const held = panning.value;
    return { markWhenShown: refusedMark(zeroArmedTurn(now, refused, held)) };
  });
  const zeroShown = useAnimatedStyle(() => {
    const now = turn.value;
    const refused = refusedTurn.value;
    const held = panning.value;
    return { opacity: held === 0 && refused > 0 && refused === now ? 1 : 0 };
  });
  const backShown = useAnimatedStyle(() => {
    const at = landed.value;
    const shown = from.value;
    const pose = offset.value;
    return { opacity: at !== "" && at === rendered && shown === rendered && pose === 0 ? 1 : 0 };
  }, [rendered]);
  return (
    <>
      <UiFrameMark testID="pagerZeroMark" style={[uiFrameMarkStyle, zeroShown]} animatedProps={zeroArmed} />
      <UiFrameMark testID="pagerBackMark" markWhenShown={`dest-face:${rendered}`} style={[uiFrameMarkStyle, backShown]} />
    </>
  );
}

const cornerRadius = screenCornerRadius(tabsLayout.displayCornerRadius);

const styles = StyleSheet.create({ card: { overflow: "hidden", borderRadius: cornerRadius, ...smoothCorners }, edge: { position: "absolute", width: tabsLayout.pagerEdgeShadow }, body: { flex: 1 }, warm: { position: "absolute" }, statusOver: { position: "absolute", left: 0, right: 0, top: 0 } });
