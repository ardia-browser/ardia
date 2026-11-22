import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let listVisits = 0;

export function noteStreamingListVisit(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (listVisits += 1));
}

export function takeStreamingSiteCounts(): { streaming_list_webkit_visits?: number } {
  const taken = listVisits;
  listVisits = 0;
  return taken > 0 ? { streaming_list_webkit_visits: taken } : {};
}
