import { DeviceEventEmitter, TurboModuleRegistry, type TurboModule } from "react-native";
import type { FrameDriver } from "./frameQueue";

type FrameClock = TurboModule & Pick<FrameDriver, "requestFrame" | "cancelFrame">;

export function nativeFrameDriver(): FrameDriver | null {
  const native = TurboModuleRegistry.get<FrameClock>("ArdiaFrameClock");
  if (!native) return null;
  return {
    requestFrame: (generation) => native.requestFrame(generation),
    cancelFrame: (generation) => native.cancelFrame(generation),
    listen(frame) {
      const sub = DeviceEventEmitter.addListener("ArdiaFrameClock:frame", (event: { generation?: unknown; failed?: unknown }) => {
        if (typeof event?.generation === "number") frame(event.generation, event.failed === true);
      });
      return () => sub.remove();
    },
  };
}
