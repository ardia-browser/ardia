import { takeInputSourceKeys } from "../../platform/focus";
import { isSharing, onConsentPeriodChange } from "./choice";

onConsentPeriodChange(() => void takeInputSourceKeys());

export function takeInputSourceKeyCounts(): { input_source_keys_webkit?: number } {
  const n = takeInputSourceKeys();
  return isSharing() && Number.isSafeInteger(n) && n > 0 ? { input_source_keys_webkit: n } : {};
}
