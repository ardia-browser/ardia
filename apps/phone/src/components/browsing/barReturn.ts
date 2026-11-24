import { useLayoutEffect } from "react";
import { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
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
  const centre = useSharedValue(centreShown ? 1 : 0);
  const sides = useSharedValue(sidesShown ? 1 : 0);
  const centreSnaps = reduceMotion ? false : !centreShown || landed;
  useLayoutEffect(() => {
    if (centreSnaps) centre.value = centreShown ? 1 : 0;
    else centre.value = withTiming(centreShown ? 1 : 0, { duration: barReturnMotion.fadeMs, easing: tabsCurve.easeOut });
  }, [centreShown]);
  useLayoutEffect(() => {
    sides.value = withTiming(sidesShown ? 1 : 0, { duration: sidesShown || reduceMotion ? barReturnMotion.fadeMs : barReturnMotion.leaveMs, easing: tabsCurve.easeOut });
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
    centreGlass: { shown: centreShown, shownMs: 0 },
    sidesGlass: { shown: sidesShown, shownMs: sidesShown || reduceMotion ? barReturnMotion.fadeMs : barReturnMotion.leaveMs },
    centreGlyphs,
    leadingGlyphs,
    trailingGlyphs,
    leading,
    trailing,
  };
}

function sideMove(shown: number, outward: number, reduceMotion: boolean) {
  "worklet";
  return { transform: [{ translateX: reduceMotion ? 0 : outward * (1 - shown) }] };
}
