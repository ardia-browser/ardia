import { useEffect, useRef, useState } from "react";
import { Animated, AppState } from "react-native";
import { easeInOutCubic, easeOutCubic, PEEK_CLOSE_DELAY_MS } from "./dockMotion";
import { curve, duration } from "../ui/motion";
import { ARC_PEEK_OUT_MS, PEEK_IN_MS } from "./tokens";
import { backgroundInstance } from "../../state/app/appSettings";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { noteSidebarEdgeRevealThroughOverlay, noteSidebarPeekPastTarget } from "../../state/telemetry/dockCounts";

const SLIDE_MS = duration.base;
const appInFront = () => backgroundInstance || AppState.currentState === "active";

export function usePeek(
  enabled: boolean,
  arc = false,
  held: () => boolean = () => false,
  onSlideOut: () => void = () => {},
  onOpen: (bounce: boolean) => void = () => {},
) {
  const slide = useRef(new Animated.Value(0)).current;
  const [live, setLive] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldBack = useRef(false);
  const out = useRef(false);
  const waitingForFocus = useRef(false);
  const overlayPending = useRef(false);
  const reveal = useRef<{ consent: ConsentToken | null; pastTarget: boolean } | null>(null);
  const animate = (to: number, done?: () => void) =>
    (to > 0
      ? Animated.timing(slide, { toValue: to, duration: PEEK_IN_MS, easing: easeOutCubic, useNativeDriver: true })
      : arc
        ? Animated.timing(slide, { toValue: to, duration: ARC_PEEK_OUT_MS, easing: easeInOutCubic, useNativeDriver: true })
        : Animated.timing(slide, { toValue: to, duration: SLIDE_MS, easing: curve.enter, useNativeDriver: true })
    ).start(({ finished }) => finished && done?.());
  const slideOut = () => {
    out.current = false;
    reveal.current = null;
    setLeaving(true);
    onSlideOut();
    animate(0, () => {
      setLive(false);
      setLeaving(false);
    });
  };
  const open = (throughOverlay: boolean) => {
    clearTimeout(hideTimer.current);
    heldBack.current = false;
    if (!enabled) return;
    overlayPending.current = throughOverlay || (waitingForFocus.current && overlayPending.current);
    if (!out.current && !appInFront()) {
      waitingForFocus.current = true;
      return;
    }
    waitingForFocus.current = false;
    if (!out.current) {
      reveal.current = { consent: consentToken(), pastTarget: false };
      if (overlayPending.current) noteSidebarEdgeRevealThroughOverlay(reveal.current.consent);
      onOpen(live);
    }
    overlayPending.current = false;
    out.current = true;
    setLeaving(false);
    setLive(true);
    animate(1);
  };
  const show = () => open(false);
  const showThroughOverlay = () => open(true);
  const cancelPending = (pointerStillAtEdge = false) => {
    waitingForFocus.current &&= pointerStillAtEdge;
    overlayPending.current &&= waitingForFocus.current;
  };
  const hide = (now = false) => {
    clearTimeout(hideTimer.current);
    if (!out.current) return cancelPending();
    hideTimer.current = setTimeout(() => {
      heldBack.current = held();
      if (!heldBack.current) slideOut();
    }, now ? 0 : PEEK_CLOSE_DELAY_MS);
  };
  const recheck = () => {
    if (!heldBack.current || held()) return;
    heldBack.current = false;
    hide();
  };
  const reset = () => {
    clearTimeout(hideTimer.current);
    slide.stopAnimation();
    slide.setValue(0);
    out.current = false;
    reveal.current = null;
    heldBack.current = false;
    waitingForFocus.current = overlayPending.current = false;
    setLive(false);
    setLeaving(false);
  };
  const sampleSlide = (value: number) => {
    const shown = reveal.current;
    if (!shown || shown.pastTarget || value <= 1) return;
    shown.pastTarget = true;
    noteSidebarPeekPastTarget(shown.consent);
  };
  const latestShow = useRef(show);
  latestShow.current = show;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => state === "active" && waitingForFocus.current && latestShow.current());
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (enabled) return;
    waitingForFocus.current = overlayPending.current = false;
    clearTimeout(hideTimer.current);
    if (live) slideOut();
  }, [enabled]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  return { slide, live, leaving, show, showThroughOverlay, hide, recheck, cancelPending, reset, sampleSlide };
}
