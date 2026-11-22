import { useEffect, useState } from "react";
import { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { searchStageIsNative } from "../../platform/searchStage";
import { useSearchEnding, useSearchOpen } from "../../state/search/hooks";
import { barCentreShown, SEARCH_ANCHOR_ID, SEARCH_FACE_ID, useStageBar } from "../../state/search/stageBar";
import { barReturnMotion, tabsCurve, useReduceMotion } from "../ui";

export type BarReturn = ReturnType<typeof useStageBarReturn>;

const STAGE_BAR_IDS = { anchor: SEARCH_ANCHOR_ID, face: SEARCH_FACE_ID } as const;

export function useBarReturn() {
  return useStageBarReturn(searchStageIsNative());
}

function useStageBarReturn(active: boolean) {
  const open = useSearchOpen();
  const ending = useSearchEnding();
  const onScreen = useStageBar((state) => state.onScreen);
  const presented = useStageBar((state) => state.presented);
  const morphs = useStageBar((state) => state.morphs);
  const landed = useStageBar((state) => state.landed);
  const reduceMotion = useReduceMotion();
  const centreShown = !active || barCentreShown(open, ending, { onScreen, presented, morphs });
  const sidesShown = !active || !open;
  const sidesGlass = useDelayedShow(sidesShown, reduceMotion ? 0 : barReturnMotion.delayMs);
  const centre = useSharedValue(centreShown ? 1 : 0);
  const sides = useSharedValue(sidesShown ? 1 : 0);
  const centreSnaps = reduceMotion ? false : !centreShown || landed;
  useEffect(() => {
    if (centreSnaps) centre.value = centreShown ? 1 : 0;
    else centre.value = withTiming(centreShown ? 1 : 0, { duration: barReturnMotion.fadeMs, easing: tabsCurve.easeOut });
  }, [centreShown]);
  useEffect(() => {
    if (reduceMotion) sides.value = withTiming(sidesShown ? 1 : 0, { duration: barReturnMotion.fadeMs, easing: tabsCurve.easeOut });
    else if (sidesShown) sides.value = withDelay(barReturnMotion.delayMs, withSpring(1, barReturnMotion.back));
    else sides.value = withTiming(0, { duration: barReturnMotion.leaveMs, easing: tabsCurve.easeOut });
  }, [sidesShown]);
  const centreGlyphs = useAnimatedStyle(() => ({ opacity: centre.value }));
  const leadingGlyphs = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(sides.value, 0), 1) }));
  const trailingGlyphs = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(sides.value, 0), 1) }));
  const leading = useAnimatedStyle(() => sideMove(sides.value, -barReturnMotion.shift, reduceMotion), [reduceMotion]);
  const trailing = useAnimatedStyle(() => sideMove(sides.value, barReturnMotion.shift, reduceMotion), [reduceMotion]);
  return {
    ids: active ? STAGE_BAR_IDS : null,
    centreShown,
    sidesShown,
    centreGlass: { shown: centreShown, shownMs: centreSnaps ? 0 : barReturnMotion.fadeMs },
    sidesGlass: { shown: sidesGlass, shownMs: reduceMotion ? barReturnMotion.fadeMs : sidesShown ? barReturnMotion.fadeMs : barReturnMotion.leaveMs },
    centreGlyphs,
    leadingGlyphs,
    trailingGlyphs,
    leading,
    trailing,
  };
}

function useDelayedShow(shown: boolean, delayMs: number) {
  const [delayed, setDelayed] = useState(shown);
  useEffect(() => {
    if (!shown || delayMs === 0) {
      setDelayed(shown);
      return;
    }
    const later = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(later);
  }, [shown, delayMs]);
  return delayed;
}

function sideMove(shown: number, outward: number, reduceMotion: boolean) {
  "worklet";
  if (reduceMotion) return { transform: [{ translateX: 0 }, { scale: 1 }] };
  const scale = barReturnMotion.scale + (1 - barReturnMotion.scale) * shown;
  return { transform: [{ translateX: outward * (1 - shown) }, { scale }] };
}
