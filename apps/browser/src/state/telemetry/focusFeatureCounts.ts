import { takeChromeSettingsOpens } from "./chromeSettingsOpens";
import { takeHiddenElementCounts } from "./hiddenElementCounts";
import { takeMinimalismCounts } from "./minimalismCounts";
import { takePageFocusReturns } from "./pageFocusReturns";
import { takeReaderCounts } from "./readerCounts";
import { takeWebNotificationCounts } from "./webNotificationCounts";
import { takeWindowOcclusionCounts } from "./windowOcclusionCounts";
import { takeBarLoadFocusCounts } from "./barLoadFocus";
import { takeFocusHandoffCounts } from "./focusHandoffCounts";
import { takePageCursorCounts } from "./pageCursorCounts";

export function takeFocusFeatureCounts() {
  return { ...takeMinimalismCounts(), ...takeReaderCounts(), ...takeHiddenElementCounts(), ...takeChromeSettingsOpens(), ...takeWindowOcclusionCounts(), ...takePageFocusReturns(), ...takeBarLoadFocusCounts(), ...takePageCursorCounts(), ...takeFocusHandoffCounts(), ...takeWebNotificationCounts() };
}
