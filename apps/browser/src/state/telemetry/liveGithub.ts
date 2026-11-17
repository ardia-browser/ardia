const NONE = { sent: 0, held: 0, rateLimited: 0, detailsFetched: 0, detailsReused: 0 };
let counts = { ...NONE };

export const noteLiveGithubRequest = (outcome: "sent" | "held" | "rateLimited") => void counts[outcome]++;

export function noteLiveGithubDetails(fetched: number, reused: number) {
  counts.detailsFetched += fetched;
  counts.detailsReused += reused;
}

export function takeLiveGithubCounts() {
  const taken = {
    live_github_requests: counts.sent,
    live_github_requests_held: counts.held,
    live_github_rate_limited: counts.rateLimited,
    live_github_details_fetched: counts.detailsFetched,
    live_github_details_reused: counts.detailsReused,
  };
  counts = { ...NONE };
  return taken;
}
