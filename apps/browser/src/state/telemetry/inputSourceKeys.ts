import { takeInputSourceKeys } from "../../platform/focus";
import { isSharing, useTelemetry } from "./choice";

useTelemetry.subscribe((current, previous) => {
  if (current.sharing !== previous.sharing) takeInputSourceKeys();
});

export function takeInputSourceKeyCounts(): { input_source_keys_webkit?: number } {
  const n = takeInputSourceKeys();
  return isSharing() && Number.isSafeInteger(n) && n > 0 ? { input_source_keys_webkit: n } : {};
}
