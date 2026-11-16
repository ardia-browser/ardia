import { capture as send } from "./client";
import { takeDownloadsPanelCauses } from "./downloadsPanelCauses";
import { takeExportCounts } from "./exportCounts";
import { takeDialogPageCounts } from "./dialogPageCounts";
import { takeExternalAppCounts } from "./externalAppCounts";
import { takeFindCounts } from "./findCounts";
import { takeFirstRunCounts } from "./firstRunCounts";
import { takeImportRuns } from "./importRuns";
import { takeInlineCompletionCounts } from "./inlineCompletionCounts";
import { takeKeyboardFollowCounts } from "./keyboardFollowCounts";
import { takeMemoryTrimCounts } from "./memoryTrimCounts";
import { takePagerCounts } from "./pagerCounts";
import { takePlatformCounts, watchPlatformCounts } from "./platformCounts";
import { takeProfileDataCounts } from "./profileDataCounts";
import { takeSyncFileCounts } from "./syncFileCounts";

export { watchPlatformCounts };

export const USAGE_COUNTS_EVENT = "usage_counts";

export const takeHourlyExtras = () => ({ ...takePlatformCounts(), ...takeImportRuns(), ...takeProfileDataCounts(), ...takeExportCounts(), ...takeInlineCompletionCounts(), ...takeFirstRunCounts(), ...takeMemoryTrimCounts(), ...takeDownloadsPanelCauses(), ...takeExternalAppCounts(), ...takeDialogPageCounts(), ...takeFindCounts(), ...takeSyncFileCounts(), ...takeKeyboardFollowCounts(), ...takePagerCounts() });

type Send = typeof send;

export function usageWithExtras(sendEvent: Send, takeExtras: () => Record<string, number | undefined>, now: () => number = Date.now) {
  let sentWithCounts = false;
  let since = now();
  const capture: Send = (event, props = {}, options = {}) => {
    if (event !== USAGE_COUNTS_EVENT) return sendEvent(event, props, options);
    sentWithCounts = true;
    sendEvent(event, { ...takeExtras(), ...props }, options);
  };
  const withHourlyExtras = (emitCounts: () => void) => {
    sentWithCounts = false;
    emitCounts();
    if (!sentWithCounts) {
      const extras = takeExtras();
      if (Object.values(extras).some(Boolean)) sendEvent(USAGE_COUNTS_EVENT, { ...extras, period_minutes: Math.round((now() - since) / 60_000) });
    }
    since = now();
  };
  return { capture, withHourlyExtras };
}

export const { capture, withHourlyExtras } = usageWithExtras(send, takeHourlyExtras);
