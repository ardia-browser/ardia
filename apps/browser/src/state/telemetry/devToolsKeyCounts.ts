import { onDevToolsKeyKept } from "../../platform/performance";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let kept = 0;

onDevToolsKeyKept((e) =>
  counted(
    nativeConsent(e),
    () => void (kept += 1),
    () => capture("usage_counts", { devtools_keys_kept: 1 }, null),
  ),
);

export function takeDevToolsKeyCounts() {
  const taken = { devtools_keys_kept: kept };
  kept = 0;
  return taken;
}
