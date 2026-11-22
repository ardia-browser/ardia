import { parseRemoteSuggestions, suggestReplyJson, suggestRequestUrl, type RemoteSite, type RemoteSuggestions, type SearchEngine } from "./engines.ts";

type FetchResponse = { ok: boolean; text(): Promise<string> };
export type FetchLike = (url: string, init: { signal: AbortSignal; engine?: SearchEngine }) => Promise<FetchResponse>;

export type SuggestFetcher = {
  request(engine: SearchEngine, query: string, onResult: (suggestions: string[], sites: RemoteSite[]) => void): void;
  cancel(): void;
};

export function createSuggestFetcher({
  fetch,
  delay = 120,
  cacheSize = 64,
}: {
  fetch: FetchLike;
  delay?: number;
  cacheSize?: number;
}): SuggestFetcher {
  const cache = new Map<string, RemoteSuggestions>();
  const none: RemoteSuggestions = { queries: [], sites: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let generation = 0;

  const cancel = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    inFlight?.abort();
    inFlight = undefined;
  };

  const remember = (url: string, suggestions: RemoteSuggestions) => {
    cache.delete(url);
    cache.set(url, suggestions);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  };

  return {
    cancel,
    request(engine, query, onResult) {
      cancel();
      const url = suggestRequestUrl(engine, query);
      if (!url) return;
      const current = generation;
      const cached = cache.get(url);
      if (cached) {
        void Promise.resolve().then(() => current === generation && onResult(cached.queries, cached.sites));
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        const controller = new AbortController();
        inFlight = controller;
        fetch(url, { signal: controller.signal, engine })
          .then(async (res) => {
            if (!res.ok) return none;
            try {
              return parseRemoteSuggestions(suggestReplyJson(await res.text()));
            } catch {
              return none;
            }
          })
          .then(
            (suggestions) => {
              if (controller.signal.aborted) return;
              remember(url, suggestions);
              if (current === generation) {
                inFlight = undefined;
                onResult(suggestions.queries, suggestions.sites);
              }
            },
            () => {},
          );
      }, delay);
    },
  };
}
