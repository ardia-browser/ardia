import { countFor, type ConsentToken } from "./consentPeriod";

let runs = 0;
let refused = 0;
let keptPinnedTabs = 0;

export function noteBookmarkletRun(ran: boolean) {
  if (ran) runs++;
  else refused++;
}

export const noteBookmarkKeptPinnedTab = (consent: ConsentToken | null) => countFor(consent, () => void keptPinnedTabs++);

export function takeBookmarkletCounts() {
  const taken = { bookmarklet_runs: runs, bookmarklets_refused: refused, bookmarks_kept_pinned_tab: keptPinnedTabs };
  runs = 0;
  refused = 0;
  keptPinnedTabs = 0;
  return taken;
}
