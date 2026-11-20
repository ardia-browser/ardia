import { useEffect } from "react";
import { useFrameCallback, useSharedValue } from "react-native-reanimated";
import { setUiFrameRecorder } from "../../state/app/interactionPerf";

const MAX_UI_FRAMES = 600;

export function FrameProbe() {
  const deltas = useSharedValue<number[]>([]);
  const probe = useFrameCallback((frame) => {
    "worklet";
    const since = frame.timeSincePreviousFrame;
    if (since === null) return;
    deltas.modify((list) => {
      "worklet";
      if (list.length < MAX_UI_FRAMES) list.push(since);
      return list;
    });
  }, false);
  useEffect(() => {
    setUiFrameRecorder({
      start: () => {
        deltas.value = [];
        probe.setActive(true);
      },
      stop: () => {
        probe.setActive(false);
        return [...deltas.value];
      },
    });
    return () => setUiFrameRecorder(null);
  }, [deltas, probe]);
  return null;
}
