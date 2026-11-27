import { hostOf } from "@ardia/core";
import type { PageEngine } from "../../platform/tabs";
import { dismissPermissions } from "../site/permissions";
import { answerExternalApp } from "../site/prompts";
import { setPageSelection } from "../site/selection";
import { clearEngineOffer, notePageEnded } from "../engines/actions";
import { followSiteChoice } from "../engines/siteMoves";
import { madeByPage, notePageMadeTab } from "../engines/openedPages";
import { revealToolbar } from "../windows/toolbarAutoHide";
import { noteCaptureIndicatorCleared, noteMediaCardCleared } from "../telemetry/tabSleepCounts";
import { setNowPlaying, useMedia } from "../media/media";
import { patchPage, pageOf, setPopover } from "./pageState";
import { isQuitting } from "../app/quit";
import { closeTabNow } from "./actions";
import { closedByUnload } from "../profiles/profileUnloading";
import { forgetRendererHang } from "../telemetry/freezes";
import { forgetVerificationCodes } from "../site/verificationCodes";
import { useBrowser } from "../browser/store";
import { siteOf } from "../engines/engines";
import { navigationOf } from "./pageSession";

export function leftPage(tabId: string, url: string, previousPage: string, engine: PageEngine) {
  if (pageOf(tabId).externalApp && hostOf(url) !== hostOf(previousPage)) answerExternalApp(tabId, false);
  dismissPermissions(tabId);
  setPopover(tabId, null);
  setPageSelection(tabId, null);
  clearEngineOffer(tabId);
  forgetVerificationCodes(tabId);
  patchPage(tabId, { popups: [], passwordPrompt: null, crashed: null, status: "" });
  revealToolbar(tabId);
  followSiteChoice(tabId, engine, url, previousPage);
}

export function arrivedOnFirstPage(tabId: string, url: string, engine: PageEngine) {
  const t = useBrowser.getState().tabs[tabId];
  if (madeByPage(t)) {
    notePageMadeTab(tabId);
    return followSiteChoice(tabId, engine, url, "");
  }
  const askedSite = siteOf(navigationOf(t)?.url);
  if (askedSite && siteOf(url) && askedSite !== siteOf(url)) followSiteChoice(tabId, engine, url, "");
}

export function pageEnded(tabId: string) {
  notePageEnded(tabId);
  forgetRendererHang(tabId);
  if (useMedia.getState().sessions[tabId]) {
    noteMediaCardCleared();
    setNowPlaying(tabId, null);
  }
  if (!pageOf(tabId).mediaAccess) return;
  noteCaptureIndicatorCleared();
  patchPage(tabId, { mediaAccess: null });
}

export function pageAskedToClose(tabId: string) {
  if (!isQuitting() && !closedByUnload(tabId)) closeTabNow(tabId);
}
