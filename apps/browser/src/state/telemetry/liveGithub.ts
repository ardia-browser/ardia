import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NONE = { sent: 0, held: 0, rateLimited: 0, detailsFetched: 0, detailsReused: 0, blockedListings: 0 };
let counts = { ...NONE };

export const noteLiveGithubRequest = (outcome: "sent" | "held" | "rateLimited", consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[outcome]++);

export const noteLiveGithubBlocked = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.blockedListings++);

export function noteLiveGithubDetails(fetched: number, reused: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    counts.detailsFetched += fetched;
    counts.detailsReused += reused;
  });
}

export function takeLiveGithubCounts() {
  const taken = {
    live_github_requests: counts.sent,
    live_github_requests_held: counts.held,
    live_github_rate_limited: counts.rateLimited,
    live_github_details_fetched: counts.detailsFetched,
    live_github_details_reused: counts.detailsReused,
    live_github_blocked_listings: counts.blockedListings,
  };
  counts = { ...NONE };
  return taken;
}
