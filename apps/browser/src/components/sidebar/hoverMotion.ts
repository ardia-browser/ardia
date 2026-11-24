import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { curve } from "../ui/motion";
import type { Anchor } from "../../state/sidebar/sidebarUi";
import { hoverCardAt, hoverCardBox, type HoverCardFrame } from "./hoverPlacement";
import { SIDEBAR_MOTION } from "./tokens";
import { whenRowsStill } from "../../state/sidebar/hover";

export const HOVER_CARD_FADE_MS = SIDEBAR_MOTION.hoverCardFade;

const fade = curve.fade;

const HoverCardFrameContext = createContext<HoverCardFrame>({ side: "left", windowWidth: 0, sidebarEdge: 0 });
export const HoverCardFrameProvider = HoverCardFrameContext.Provider;
const useHoverCardFrame = () => useContext(HoverCardFrameContext);

export function useHoverCardOrigin(anchor: Anchor) {
  const frame = useHoverCardFrame();
  return hoverCardBox(hoverCardAt(anchor, frame), frame);
}

function createMotion() {
  const opacity = new Animated.Value(0);
  return { opacity, style: { opacity } };
}

const hoverCardMotions = new Map<string, ReturnType<typeof createMotion>>();

export function useHoverCardMotion<T>(key: string, target: T | null) {
  const [motion] = useState(createMotion);
  const [drawn, setDrawn] = useState<T | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [entering, setEntering] = useState(false);
  const state = useRef({ drawn: null as T | null, leaving: false, run: 0, fade: 0, teardown: () => {} });

  useLayoutEffect(() => {
    if (!__DEV__) return;
    hoverCardMotions.set(key, motion);
    return () => void hoverCardMotions.delete(key);
  }, [key, motion]);

  useLayoutEffect(() => {
    const s = state.current;
    const run = ++s.run;
    s.teardown();
    if (target) {
      const fresh = !s.drawn;
      const returning = s.leaving;
      s.drawn = target;
      s.leaving = false;
      setDrawn(target);
      setLeaving(false);
      if (!fresh && !returning) return;
      if (fresh) {
        motion.opacity.setValue(0);
        setEntering(true);
      }
      const fadeIn = ++s.fade;
      Animated.timing(motion.opacity, { toValue: 1, duration: HOVER_CARD_FADE_MS, easing: fade, useNativeDriver: true }).start(({ finished }) => {
        if (finished && state.current.fade === fadeIn) setEntering(false);
      });
      return;
    }
    if (!s.drawn || s.leaving) return;
    s.leaving = true;
    s.fade++;
    setLeaving(true);
    Animated.timing(motion.opacity, { toValue: 0, duration: HOVER_CARD_FADE_MS, easing: fade, useNativeDriver: true }).start(({ finished }) => {
      if (!finished || state.current.run !== run) return;
      state.current.teardown = whenRowsStill(key, () => {
        if (state.current.run !== run) return;
        state.current.drawn = null;
        state.current.leaving = false;
        setDrawn(null);
        setLeaving(false);
        setEntering(false);
      });
    });
  }, [target]);

  useLayoutEffect(
    () => () => {
      motion.opacity.stopAnimation();
      state.current.teardown();
    },
    [],
  );

  return { drawn, leaving, entering, motion };
}

export function useHoverFade(shown: boolean) {
  const [opacity] = useState(() => new Animated.Value(shown ? 1 : 0));
  useEffect(() => {
    const fade = Animated.timing(opacity, { toValue: shown ? 1 : 0, duration: HOVER_CARD_FADE_MS, easing: curve.fade, useNativeDriver: true });
    fade.start();
    return () => fade.stop();
  }, [shown]);
  return opacity;
}
