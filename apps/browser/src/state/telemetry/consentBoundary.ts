import { setConsentEpoch } from "../../platform/focus";
import { rendererEfficiency } from "../../platform/rendererEfficiency";
import { consentEpoch, onConsentPeriodChange } from "./choice";
import { takeColdTabHoldCounts, takeContentDriftCounts, takeMainProcessWork } from "./diagnostics";
import { takeFreezeCounts } from "./freezes";
import { takeStopBreathing } from "./stopBreathing";
import { resetLocalStoreMeters } from "./localStore";
import { resetPostStats } from "./transport";

let dropUsage = () => {};

onConsentPeriodChange(() => {
  setConsentEpoch(consentEpoch());
  rendererEfficiency.setConsentEpoch(consentEpoch());
  dropUsage();
  resetLocalStoreMeters();
  resetPostStats();
  void takeMainProcessWork().catch(() => null);
  void takeContentDriftCounts().catch(() => null);
  void takeColdTabHoldCounts().catch(() => null);
  takeFreezeCounts(null);
  takeStopBreathing();
});

export function watchConsentBoundary(drop: () => void) {
  dropUsage = drop;
  setConsentEpoch(consentEpoch());
  rendererEfficiency.setConsentEpoch(consentEpoch());
}
