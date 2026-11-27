import { useCallback, useEffect, useRef } from "react";
import { cancelAnimation, defineAnimation, runOnJS, useSharedValue, type AnimationObject, type SharedValue } from "react-native-reanimated";
import { IDLE_WASH, IDLE_WASH_INPUT, stepWash, washRests, type WashInput, type WashState } from "../../lib/loadWash";
import { launchArguments } from "../../state/app/launchFlags";
import { watchPageLoad } from "../../state/browse/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { useReduceMotion, type LoadWashValues, type LoadWatch } from "../ui";

export function pageLoadWatch(tabId: string): LoadWatch {
  const loadFreeze = launchArguments().loadFreeze;
  if (loadFreeze !== null) return (show) => (show(loadFreeze, true), () => undefined);
  return (show) => watchPageLoad(tabId, show);
}

type WashDrive = { state: SharedValue<WashState>; input: SharedValue<WashInput>; fill: SharedValue<number>; alpha: SharedValue<number>; lastFrame: SharedValue<number>; revealed: () => void };

function washFrames(generation: number, drive: WashDrive): number {
  "worklet";
  return defineAnimation<AnimationObject<number>>(generation, () => {
    "worklet";
    const onFrame = (animation: AnimationObject<number>, now: number) => {
      const { state, input, fill, alpha, lastFrame, revealed } = drive;
      const before = lastFrame.value;
      const elapsed = before > 0 ? now - before : 0;
      lastFrame.value = now;
      const wanted = input.value;
      const next = stepWash(state.value, wanted, elapsed);
      state.value = next;
      fill.value = next.fill;
      alpha.value = next.alpha;
      animation.current = generation;
      if (next.revealed) runOnJS(revealed)();
      const rests = washRests(next, wanted);
      if (rests) lastFrame.value = 0;
      return rests;
    };
    const onStart = (animation: AnimationObject<number>) => {
      animation.current = generation;
    };
    return { onFrame, onStart, current: generation, toValue: generation, reduceMotion: false };
  }) as unknown as number;
}

export function useBarLoadWash(tabId: string, isPrivate: boolean, enabled: boolean): LoadWashValues | null {
  const reduced = useReduceMotion();
  const fill = useSharedValue(0);
  const alpha = useSharedValue(0);
  const state = useSharedValue<WashState>(IDLE_WASH);
  const input = useSharedValue<WashInput>(IDLE_WASH_INPUT);
  const lastFrame = useSharedValue(0);
  const frames = useSharedValue(0);
  const generation = useRef(0);
  const snap = useRef(0);
  const privately = useRef(isPrivate);
  privately.current = isPrivate;
  const revealed = useCallback(() => {
    if (!privately.current) countUsage("bar_load_washes");
  }, []);
  const latest = useRef({ progress: 0, loading: false });
  const push = useCallback((reducedNow: boolean, trickles: boolean) => {
    input.value = { progress: latest.current.progress, loading: latest.current.loading, snap: snap.current, trickles, reduced: reducedNow };
    generation.current += 1;
    frames.value = washFrames(generation.current, { state, input, fill, alpha, lastFrame, revealed });
  }, []);
  const reducedNow = useRef(reduced);
  reducedNow.current = reduced;
  useEffect(() => {
    if (!enabled) return;
    const trickles = launchArguments().loadFreeze === null;
    snap.current += 1;
    return pageLoadWatch(tabId)((progress, loading) => {
      latest.current = { progress, loading };
      push(reducedNow.current, trickles);
    });
  }, [enabled, tabId, push]);
  useEffect(() => {
    if (enabled) push(reduced, launchArguments().loadFreeze === null);
  }, [enabled, reduced, push]);
  useEffect(() => {
    if (enabled) return;
    cancelAnimation(frames);
    lastFrame.value = 0;
    state.value = IDLE_WASH;
    fill.value = 0;
    alpha.value = 0;
  }, [enabled]);
  useEffect(() => () => cancelAnimation(frames), []);
  return enabled ? { fill, alpha } : null;
}
