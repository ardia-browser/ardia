import { capture as send, stillValid } from "./client";
import { takeDownloadsPanelCauses } from "./downloadsPanelCauses";
import { takeSessionWrites } from "./sessionWrites";
import { takeEditKeyAckCounts } from "./editKeyAcks";
import { takeExportCounts } from "./exportCounts";
import { takeDevToolsKeyCounts } from "./devToolsKeyCounts";
import { takeDialogPageCounts } from "./dialogPageCounts";
import { takeExternalAppCounts } from "./externalAppCounts";
import { takeFindCounts } from "./findCounts";
import { takeFirstRunCounts } from "./firstRunCounts";
import { takeArcImportCounts, takeImportRuns } from "./importRuns";
import { takeInputSourceKeyCounts } from "./inputSourceKeys";
import { takeInlineCompletionCounts } from "./inlineCompletionCounts";
import { takeKeyboardFollowCounts } from "./keyboardFollowCounts";
import { takeMemoryTrimCounts } from "./memoryTrimCounts";
import { takeMouseShortcutCounts } from "./mouseShortcutCounts";
import { takeOfficialPluginCounts } from "./officialPluginCounts";
import { takePagerCounts } from "./pagerCounts";
import { takePeekMotionCounts } from "./peekMotion";
import { takePageFaviconCounts } from "./pageFaviconCounts";
import { takePlatformCounts, watchPlatformCounts } from "./platformCounts";
import { takeProfileDataCounts } from "./profileDataCounts";
import { takeQuitWarningCounts } from "./quitWarningCounts";
import { takeRendererEfficiencyCounts } from "./rendererEfficiencyCounts";
import { takeSwipeHistoryListCounts } from "./swipeHistoryListCounts";
import { takeStreamingSiteCounts } from "./streamingSiteCounts";
import { takeSyncFileCounts } from "./syncFileCounts";

export { watchPlatformCounts };

export const USAGE_COUNTS_EVENT = "usage_counts";

export const takeHourlyExtras = () => ({ ...takePlatformCounts(), ...takeOfficialPluginCounts(), ...takeImportRuns(), ...takeArcImportCounts(), ...takeProfileDataCounts(), ...takeExportCounts(), ...takeInlineCompletionCounts(), ...takeFirstRunCounts(), ...takeMemoryTrimCounts(), ...takeDownloadsPanelCauses(), ...takeExternalAppCounts(), ...takeDialogPageCounts(), ...takeFindCounts(), ...takeSyncFileCounts(), ...takeKeyboardFollowCounts(), ...takePagerCounts(), ...takeSwipeHistoryListCounts(), ...takeEditKeyAckCounts(), ...takeQuitWarningCounts(), ...takeInputSourceKeyCounts(), ...takeDevToolsKeyCounts(), ...takeSessionWrites(), ...takePeekMotionCounts(), ...takeMouseShortcutCounts(), ...takePageFaviconCounts(), ...takeStreamingSiteCounts(), ...takeRendererEfficiencyCounts() });

type Send = typeof send;

export function usageWithExtras(sendEvent: Send, takeExtras: () => Record<string, number | undefined>, now: () => number = Date.now) {
  let sentWithCounts = false;
  let draining = false;
  let since = now();
  const capture: Send = (event, props, consent, options = {}) => {
    if (event !== USAGE_COUNTS_EVENT || !(draining || stillValid(consent))) return sendEvent(event, props, consent, options);
    sentWithCounts = true;
    sendEvent(event, { ...takeExtras(), ...props }, consent, options);
  };
  const withHourlyExtras = (emitCounts: () => void, consent: Parameters<Send>[2]) => {
    sentWithCounts = false;
    draining = true;
    try {
      emitCounts();
    } finally {
      draining = false;
    }
    if (!sentWithCounts) {
      const extras = takeExtras();
      if (Object.values(extras).some(Boolean)) sendEvent(USAGE_COUNTS_EVENT, { ...extras, period_minutes: Math.round((now() - since) / 60_000) }, consent);
    }
    since = now();
  };
  return { capture, withHourlyExtras };
}

export const { capture, withHourlyExtras } = usageWithExtras(send, takeHourlyExtras);
