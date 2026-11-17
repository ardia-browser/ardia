export const RESERVE_RATIO = 0.1;
export const FALLBACK_COOLDOWN_MS = 30_000;
export const MAX_FALLBACK_COOLDOWN_MS = 15 * 60_000;
export const GITHUB_CONCURRENCY = 4;

export type HeaderReader = { get(name: string): string | null };

type Quota = { limit: number; remaining: number; resetAt: number };
type Pause = { attempt: number; retryAt: number };

export function quotaFromHeaders(headers: HeaderReader): Quota | null {
  const limit = Number(headers.get("x-ratelimit-limit") ?? NaN);
  const remaining = Number(headers.get("x-ratelimit-remaining") ?? NaN);
  const reset = Number(headers.get("x-ratelimit-reset") ?? NaN);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(reset)) return null;
  return { limit, remaining, resetAt: reset * 1000 };
}

export function retryAtFromHeaders(headers: HeaderReader | null, now: number): number | undefined {
  const retryAfter = headers?.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > now) return date;
  }
  const reset = Number(headers?.get("x-ratelimit-reset") ?? NaN) * 1000;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}

export const fallbackCooldownMs = (attempt: number) => Math.min(FALLBACK_COOLDOWN_MS * 2 ** Math.max(0, attempt - 1), MAX_FALLBACK_COOLDOWN_MS);

export function namesRateLimit(text: unknown): boolean {
  return typeof text === "string" && /rate limit|abuse detection mechanism/i.test(text);
}

export function graphqlRateLimited(errors: readonly { type?: string; message?: string }[] | undefined, headers: HeaderReader | null): boolean {
  if (!errors?.length) return false;
  return headers?.get("x-ratelimit-remaining") === "0" || errors.some((e) => e.type === "RATE_LIMITED" || (typeof e.message === "string" && /rate limit (already )?exceeded/i.test(e.message)));
}

export function createGithubLimits(clock: () => number = Date.now, concurrency = GITHUB_CONCURRENCY) {
  const quotas = new Map<string, Quota>();
  const pauses = new Map<string, Pause>();
  let active = 0;
  const waiting: (() => void)[] = [];

  function blockedUntil(scope: string, interactive: boolean): number | null {
    const now = clock();
    const quota = quotas.get(scope);
    const floor = interactive ? 1 : (quota?.limit ?? 0) * RESERVE_RATIO;
    const byQuota = quota && quota.resetAt > now && quota.remaining < floor ? quota.resetAt : null;
    const pause = pauses.get(scope);
    const byPause = !interactive && pause && pause.retryAt > now ? pause.retryAt : null;
    return byQuota === null && byPause === null ? null : Math.max(byQuota ?? 0, byPause ?? 0);
  }

  function observe(scope: string, headers: HeaderReader) {
    record(scope, quotaFromHeaders(headers));
  }

  function observeBody(scope: string, rateLimit: { limit: number; remaining: number; resetAt: string } | null | undefined) {
    const resetAt = rateLimit ? Date.parse(rateLimit.resetAt) : NaN;
    if (!rateLimit || !Number.isFinite(resetAt) || !(rateLimit.limit > 0) || !(rateLimit.remaining >= 0)) return;
    record(scope, { limit: rateLimit.limit, remaining: rateLimit.remaining, resetAt });
  }

  function record(scope: string, quota: Quota | null) {
    if (!quota) return;
    const previous = quotas.get(scope);
    if (previous && quota.resetAt < previous.resetAt) return;
    quotas.set(scope, quota);
  }

  function rateLimited(scope: string, retryAt?: number) {
    const now = clock();
    const previous = pauses.get(scope);
    const attempt = (previous?.attempt ?? 0) + 1;
    const proposed = retryAt !== undefined && retryAt > now ? retryAt : now + fallbackCooldownMs(attempt);
    pauses.set(scope, { attempt, retryAt: previous && previous.retryAt > now ? Math.max(previous.retryAt, proposed) : proposed });
  }

  function succeeded(scope: string) {
    const pause = pauses.get(scope);
    if (pause && pause.retryAt <= clock()) pauses.delete(scope);
  }

  async function withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  function forget(scope: string) {
    quotas.delete(scope);
    pauses.delete(scope);
  }

  return { blockedUntil, observe, observeBody, rateLimited, succeeded, withSlot, forget };
}

export type GithubLimits = ReturnType<typeof createGithubLimits>;
