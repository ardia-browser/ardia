import { isSuggestReplyShape, parseRemoteSuggestions, suggestReplyJson, suggestRequestUrl, type RemoteSite, type RemoteSuggestions, type SearchEngine } from "./engines.ts";

type FetchResponse = { ok: boolean; blocked?: boolean; retryAfterMs?: number; text(): Promise<string> };
export type FetchLike = (url: string, init: { signal: AbortSignal; engine?: SearchEngine }) => Promise<FetchResponse>;

export type SuggestBackoff = {
  until: number;
  failures: number;
  revision: number;
};

export type SuggestStore = {
  cache: Map<string, RemoteSuggestions>;
  backoff: Map<string, SuggestBackoff>;
  lastSentAt: number;
  backoffRevision: number;
};

export const createSuggestStore = (): SuggestStore => ({
  cache: new Map(),
  backoff: new Map(),
  lastSentAt: 0,
  backoffRevision: 0,
});

export type SuggestFetcher = {
  request(engine: SearchEngine, query: string, onResult: (suggestions: string[], sites: RemoteSite[]) => void, onFailed?: () => void): void;
  cancel(): void;
};

const DEFAULT_DELAY_MS = 150;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;

export function createSuggestFetcher({
  fetch,
  delay = DEFAULT_DELAY_MS,
  minInterval = delay >= DEFAULT_DELAY_MS ? DEFAULT_MIN_INTERVAL_MS : 0,
  cacheSize = 64,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  now = Date.now,
  store = createSuggestStore(),
  onThrottled,
}: {
  fetch: FetchLike;
  delay?: number;
  minInterval?: number;
  cacheSize?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  store?: SuggestStore;
  onThrottled?: () => void;
}): SuggestFetcher {
  const { cache, backoff } = store;
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

  const isBackedOff = (engineId: string) => {
    const state = backoff.get(engineId);
    if (!state) return false;
    const remaining = state.until - now();
    if (remaining > backoffMaxMs) {
      backoff.delete(engineId);
      return false;
    }
    return remaining > 0;
  };

  const noteBlocked = (engineId: string, retryAfterMs?: number) => {
    const t = now();
    const failures = (backoff.get(engineId)?.failures ?? 0) + 1;
    const base = backoffBaseMs * 2 ** Math.min(failures - 1, 4);
    const wait = Math.min(backoffMaxMs, Math.max(retryAfterMs ?? 0, base));
    const revision = ++store.backoffRevision;
    backoff.set(engineId, { failures, until: t + wait, revision });
  };

  const paceRemaining = () => {
    if (minInterval <= 0 || store.lastSentAt <= 0) return 0;
    const rawElapsed = now() - store.lastSentAt;
    return rawElapsed >= 0 ? Math.max(0, minInterval - rawElapsed) : 0;
  };

  return {
    cancel,
    request(engine, query, onResult, onFailed) {
      cancel();
      const url = suggestRequestUrl(engine, query);
      if (!url) return;
      const current = generation;
      const cached = cache.get(url);
      if (cached) {
        remember(url, cached);
        void Promise.resolve().then(() => current === generation && onResult(cached.queries, cached.sites));
        return;
      }
      if (isBackedOff(engine.id)) {
        onThrottled?.();
        void Promise.resolve().then(() => current === generation && onFailed?.());
        return;
      }
      const dispatch = () => {
        timer = undefined;
        if (current !== generation) return;
        if (isBackedOff(engine.id)) {
          onThrottled?.();
          onFailed?.();
          return;
        }
        const remaining = paceRemaining();
        if (remaining > 0) {
          timer = setTimeout(dispatch, remaining);
          return;
        }
        store.lastSentAt = now();
        const dispatchRevision = store.backoffRevision;
        const controller = new AbortController();
        inFlight = controller;
        fetch(url, { signal: controller.signal, engine })
          .then(async (res) => {
            if (controller.signal.aborted) return null;
            if (!res.ok) {
              if (res.blocked) noteBlocked(engine.id, res.retryAfterMs);
              return { ok: false as const };
            }
            try {
              const parsed = suggestReplyJson(await res.text());
              if (!isSuggestReplyShape(parsed)) return { ok: false as const };
              const state = backoff.get(engine.id);
              if (state && state.revision <= dispatchRevision) backoff.delete(engine.id);
              return { ok: true as const, suggestions: parseRemoteSuggestions(parsed) };
            } catch {
              return { ok: false as const };
            }
          })
          .then(
            (outcome) => {
              if (!outcome || controller.signal.aborted) return;
              if (!outcome.ok) {
                if (current === generation) {
                  inFlight = undefined;
                  onFailed?.();
                }
                return;
              }
              remember(url, outcome.suggestions);
              if (current === generation) {
                inFlight = undefined;
                onResult(outcome.suggestions.queries, outcome.suggestions.sites);
              }
            },
            () => {
              if (controller.signal.aborted || current !== generation) return;
              inFlight = undefined;
              onFailed?.();
            },
          );
      };
      timer = setTimeout(dispatch, Math.max(delay, paceRemaining()));
    },
  };
}
