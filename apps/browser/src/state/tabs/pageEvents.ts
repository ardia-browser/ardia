import { hostOf } from "@ardia/core";
import type { PageEngine } from "../../platform/tabs";
import { dismissPermissions } from "../site/permissions";
import { answerExternalApp } from "../site/prompts";
import { setPageSelection } from "../site/selection";
import { clearEngineOffer, followSiteChoice } from "../engines/actions";
import { revealToolbar } from "../windows/toolbarAutoHide";
import { noteCaptureIndicatorCleared, noteMediaCardCleared } from "../telemetry/tabSleepCounts";
import { setNowPlaying, useMedia } from "../media/media";
import { patchPage, pageOf, setPopover } from "./pageState";
import { isQuitting } from "../app/quit";
import { closeTabNow } from "./actions";
import { closedByUnload } from "../profiles/profileUnloading";

export function leftPage(tabId: string, url: string, previousPage: string, engine: PageEngine, inPeek: boolean) {
  if (pageOf(tabId).externalApp && hostOf(url) !== hostOf(previousPage)) answerExternalApp(tabId, false);
  dismissPermissions(tabId);
  setPopover(tabId, null);
  setPageSelection(tabId, null);
  clearEngineOffer(tabId);
  patchPage(tabId, { popups: [], passwordPrompt: null, crashed: null, status: "" });
  revealToolbar(tabId);
  if (!inPeek) followSiteChoice(tabId, engine, url, previousPage);
}

export function pageEnded(tabId: string) {
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
