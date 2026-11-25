import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";

let copies = 0;
let whilePending = 0;
let selectedTabs = 0;
let trackersRemoved = 0;
let fromWebKitMenu = 0;
let uncleaned = 0;

export function noteSelectedTabUrlsCopied(cleaned = 0) {
  copies++;
  selectedTabs++;
  if (cleaned > 0) countFor(consentOrNow(undefined), () => void (trackersRemoved += cleaned));
}

export function noteUrlCopied(firstPagePending: boolean, removedTracker = false) {
  copies++;
  if (firstPagePending) whilePending++;
  if (removedTracker) countFor(consentOrNow(undefined), () => void trackersRemoved++);
}

export function noteWebKitMenuLinkCopied(removedTracker: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    fromWebKitMenu++;
    if (removedTracker) trackersRemoved++;
  });
}

export const noteUncleanedUrlCopied = (consent: ConsentToken | null) => countFor(consent, () => void uncleaned++);

export function takeUrlCopyCounts() {
  const taken = {
    url_copies: copies,
    url_copies_while_pending: whilePending,
    url_copies_of_selected_tabs: selectedTabs,
    url_copies_cleaned: trackersRemoved,
    url_copies_from_webkit_menu: fromWebKitMenu,
    url_copies_uncleaned: uncleaned,
  };
  copies = 0;
  whilePending = 0;
  selectedTabs = 0;
  trackersRemoved = 0;
  fromWebKitMenu = 0;
  uncleaned = 0;
  return taken;
}
