import {
  createSuggestFetcher as createSharedSuggestFetcher,
  createSuggestStore,
  type FetchLike,
  type SuggestBackoff,
  type SuggestFetcher,
  type SuggestStore,
} from "../../../packages/core/src/suggestFetcher.ts";
import { ardiaHost } from "./host.ts";
import { consentNow } from "../../browser/src/state/telemetry/choice";
import { hostSuggestFetch, suggestionEndpoints } from "./hostSuggestions.ts";

export { createSuggestStore };
export type { FetchLike, SuggestBackoff, SuggestFetcher, SuggestStore };

const browserStore = () => import("../../browser/src/state/browser/store");
const suggestTelemetry = () => import("../../browser/src/state/telemetry/track");

export function createSuggestFetcher(options: Parameters<typeof createSharedSuggestFetcher>[0]): SuggestFetcher {
  if (!ardiaHost) return createSharedSuggestFetcher(options);
  let extensionEndpoints: readonly string[] = [];
  const hostFetch = hostSuggestFetch(ardiaHost, () => extensionEndpoints);
  const fetch: FetchLike = async (url, init) => {
    const consent = consentNow();
    const [{ useBrowser }, { noteSearchSuggest }] = await Promise.all([browserStore(), suggestTelemetry()]);
    extensionEndpoints = suggestionEndpoints(useBrowser.getState().settings.extensionSearchEngines);
    const reply = await hostFetch(url, init);
    noteSearchSuggest(reply.ok ? "ok" : reply.blocked ? "blocked" : "failed", consent);
    return reply;
  };
  return createSharedSuggestFetcher({ ...options, fetch });
}
