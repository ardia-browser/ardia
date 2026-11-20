import { TurboModuleRegistry, type TurboModule } from "react-native";
import { addNativeListener } from "../events";
import type { DisplayFrame, FrameSource } from "./motion";

type FramesModule = TurboModule & { requestFrame(): void; now(): number };

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function displayFrames(): FrameSource {
  const native = TurboModuleRegistry.get<FramesModule>("ArdiaFrames");
  if (!native) throw new Error("ArdiaFrames is missing, so nothing can animate");
  return {
    request: () => native.requestFrame(),
    now: () => native.now(),
    onFrame(listener) {
      addNativeListener("ArdiaFrames", "onFrame", (payload) => {
        const frame = (payload ?? {}) as Partial<DisplayFrame>;
        listener({ time: finite(frame.time), interval: finite(frame.interval) });
      });
    },
  };
}
