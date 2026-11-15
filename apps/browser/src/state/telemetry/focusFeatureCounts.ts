import { takeCaptureCounts } from "./captureCounts";
import { takeChromeSettingsOpens } from "./chromeSettingsOpens";
import { takeHiddenElementCounts } from "./hiddenElementCounts";
import { takeMinimalismCounts } from "./minimalismCounts";
import { takeReaderCounts } from "./readerCounts";
import { takeWindowOcclusionCounts } from "./windowOcclusionCounts";

export function takeFocusFeatureCounts() {
  return {
    ...takeMinimalismCounts(),
    ...takeReaderCounts(),
    ...takeHiddenElementCounts(),
    ...takeCaptureCounts(),
    ...takeChromeSettingsOpens(),
    ...takeWindowOcclusionCounts(),
  };
}
