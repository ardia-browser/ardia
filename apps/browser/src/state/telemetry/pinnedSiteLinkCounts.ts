import { type ConsentToken, counted } from "./choice";
import { consentedCount } from "./consentedCount";

export const PINNED_SITE_LINK_OUTCOMES = ["peeks", "same_site", "unmatched_timed_out", "unmatched_skipped", "not_from_click", "no_opener", "page_handled"] as const;

export type PinnedSiteLinkOutcome = (typeof PINNED_SITE_LINK_OUTCOMES)[number];

const counts = new Map<string, ReturnType<typeof consentedCount>>(PINNED_SITE_LINK_OUTCOMES.map((outcome) => [outcome, consentedCount()]));

export function notePinnedSiteLink(outcome: PinnedSiteLinkOutcome, consent: ConsentToken | null) {
  counted(consent, () => counts.get(outcome)?.note());
}

export const takePinnedSiteLinkCounts = () => ({
  pinned_site_link_peeks: counts.get("peeks")!.take(),
  pinned_site_link_same_site: counts.get("same_site")!.take(),
  pinned_site_link_unmatched_timed_out: counts.get("unmatched_timed_out")!.take(),
  pinned_site_link_unmatched_skipped: counts.get("unmatched_skipped")!.take(),
  pinned_site_link_not_from_click: counts.get("not_from_click")!.take(),
  pinned_site_link_no_opener: counts.get("no_opener")!.take(),
  pinned_site_link_page_handled: counts.get("page_handled")!.take(),
});
