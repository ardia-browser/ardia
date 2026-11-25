import type { OpenWindowRequest } from "../../platform/tabs";
import { type BrowserState, useBrowser } from "../browser/store";
import { leavesSite, newTabLinkRoute } from "../peek/newTabLinkRoute";
import { peekSourceOf, peeksLinksToOtherSites } from "../peek/peek";
import { consentToken } from "../telemetry/choice";
import { type PinnedSiteLinkOutcome, notePinnedSiteLink } from "../telemetry/pinnedSiteLinkCounts";
import { asAdoptId, isAdoptKind } from "./adoptIds";

type OutcomeState = Pick<BrowserState, "tabs" | "windows" | "groups" | "peeks" | "settings">;

const watchedSource = (s: OutcomeState, sourceTabId: string | undefined) => {
  const source = sourceTabId ? s.tabs[sourceTabId] : undefined;
  if (!source || !sourceTabId || s.windows[source.windowId]?.kind !== "main" || peekSourceOf(s, sourceTabId) || !peeksLinksToOtherSites(s, sourceTabId)) return undefined;
  return source;
};

export function pinnedSiteLinkOutcome(s: OutcomeState, request: OpenWindowRequest, disposition: OpenWindowRequest["disposition"], sourceTabId: string | undefined): PinnedSiteLinkOutcome | undefined {
  const source = watchedSource(s, sourceTabId);
  if (!source || !sourceTabId || disposition !== "foreground" || !/^https?:\/\//i.test(request.url)) return undefined;
  if (!leavesSite(request.url, source.url)) return "same_site";
  const adoptId = asAdoptId(request.adoptId);
  if (isAdoptKind(adoptId, "tab")) return "no_opener";
  if (request.fromClick && isAdoptKind(adoptId, "ardiacore") && newTabLinkRoute(s, sourceTabId, request.url) === "otherSite") return "peeks";
  if (request.linkWait === "timedOut") return "unmatched_timed_out";
  if (request.linkWait === "skipped") return "unmatched_skipped";
  return "not_from_click";
}

export function notePageHandledSiteLink(sourceTabId: string) {
  if (watchedSource(useBrowser.getState(), sourceTabId)) notePinnedSiteLink("page_handled", consentToken());
}
