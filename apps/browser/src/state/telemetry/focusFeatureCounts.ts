import { takeChromeSettingsOpens } from "./chromeSettingsOpens";
import { takeHiddenElementCounts } from "./hiddenElementCounts";
import { takeMinimalismCounts } from "./minimalismCounts";
import { takeReaderCounts } from "./readerCounts";
import { takeWindowOcclusionCounts } from "./windowOcclusionCounts";

export function takeFocusFeatureCounts() {
  return { ...takeMinimalismCounts(), ...takeReaderCounts(), ...takeHiddenElementCounts(), ...takeChromeSettingsOpens(), ...takeWindowOcclusionCounts() };
}
