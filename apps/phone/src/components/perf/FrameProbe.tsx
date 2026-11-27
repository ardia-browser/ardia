import { useEffect, useRef, useState } from "react";
import { useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { setUiFrameRecorder } from "../../state/app/interactionPerf";
import { countUsage } from "../../state/telemetry/telemetry";

const MAX_UI_FRAMES = 600;

function ActiveFrameProbe({ deltas }: { deltas: SharedValue<number[]> }) {
  useFrameCallback((frame) => {
    "worklet";
    const since = frame.timeSincePreviousFrame;
    if (since === null) return;
    deltas.modify((list) => {
      "worklet";
      if (list.length < MAX_UI_FRAMES) list.push(since);
      return list;
    });
  }, true);
  return null;
}

export function FrameProbe() {
  const deltas = useSharedValue<number[]>([]);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  useEffect(() => {
    setUiFrameRecorder({
      start: () => {
        deltas.value = [];
        if (!activeRef.current) {
          activeRef.current = true;
          setActive(true);
          countUsage("frame_probe_recordings");
        }
      },
      stop: () => {
        if (activeRef.current) {
          activeRef.current = false;
          setActive(false);
        }
        return [...deltas.value];
      },
    });
    return () => setUiFrameRecorder(null);
  }, [deltas]);
  return active ? <ActiveFrameProbe deltas={deltas} /> : null;
}
