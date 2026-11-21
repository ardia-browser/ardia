import { takeChromeSettingsOpens } from "./chromeSettingsOpens";
import { takePreloadPagesCounts } from "./preloadPagesCounts";
import { takeHiddenElementCounts } from "./hiddenElementCounts";
import { takeMinimalismCounts } from "./minimalismCounts";
import { takePageFocusReturns } from "./pageFocusReturns";
import { takeReaderCounts } from "./readerCounts";
import { takeWebNotificationCounts } from "./webNotificationCounts";
import { takeWindowOcclusionCounts } from "./windowOcclusionCounts";
import { takeBarLoadFocusCounts } from "./barLoadFocus";
import { takeFocusHandoffCounts } from "./focusHandoffCounts";
import { takePageCursorCounts } from "./pageCursorCounts";
import { takePictureInPictureCloseCounts } from "./pictureInPictureCloses";
import { takePasswordManagerCounts } from "./passwordManagerCounts";
import { takePageBarCounts } from "./pageBarCounts";

export function takeFocusFeatureCounts() {
  return { ...takeMinimalismCounts(), ...takeReaderCounts(), ...takeHiddenElementCounts(), ...takeChromeSettingsOpens(), ...takePreloadPagesCounts(), ...takeWindowOcclusionCounts(), ...takePageFocusReturns(), ...takeBarLoadFocusCounts(), ...takePageCursorCounts(), ...takeFocusHandoffCounts(), ...takeWebNotificationCounts(), ...takePictureInPictureCloseCounts(), ...takePasswordManagerCounts(), ...takePageBarCounts() };
}
