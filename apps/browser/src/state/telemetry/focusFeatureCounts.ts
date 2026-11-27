import { takeChromeSettingsOpens } from "./chromeSettingsOpens";
import { takePreloadPagesCounts } from "./preloadPagesCounts";
import { takeHiddenElementCounts } from "./hiddenElementCounts";
import { takeMinimalismCounts } from "./minimalismCounts";
import { takePageFocusReturns } from "./pageFocusReturns";
import { takeReaderCounts } from "./readerCounts";
import { takeSettingsWriteCounts } from "./settingsWriteCounts";
import { takeWebNotificationCounts } from "./webNotificationCounts";
import { takeWindowOcclusionCounts } from "./windowOcclusionCounts";
import { takeBarLoadFocusCounts } from "./barLoadFocus";
import { takeFocusHandoffCounts } from "./focusHandoffCounts";
import { takeHoverCounts } from "./hoverCounts";
import { takePageCursorCounts } from "./pageCursorCounts";
import { takeCommandScrollZoomCounts } from "./commandScrollZoomCounts";
import { takePictureInPictureCloseCounts } from "./pictureInPictureCloses";
import { takeDeveloperModeCounts } from "./developerModeCounts";
import { takePasswordManagerCounts } from "./passwordManagerCounts";
import { takeSettingsPickerCounts } from "./settingsPickerCounts";
import { takePageBarCounts } from "./pageBarCounts";

export function takeFocusFeatureCounts() {
  return { ...takeMinimalismCounts(), ...takeReaderCounts(), ...takeSettingsWriteCounts(), ...takeHiddenElementCounts(), ...takeChromeSettingsOpens(), ...takePreloadPagesCounts(), ...takeWindowOcclusionCounts(), ...takePageFocusReturns(), ...takeBarLoadFocusCounts(), ...takePageCursorCounts(), ...takeCommandScrollZoomCounts(), ...takeFocusHandoffCounts(), ...takeHoverCounts(), ...takeWebNotificationCounts(), ...takePictureInPictureCloseCounts(), ...takeDeveloperModeCounts(), ...takePasswordManagerCounts(), ...takeSettingsPickerCounts(), ...takePageBarCounts() };
}
