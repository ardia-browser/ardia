export const SITES_LIMITS = {
  bodyBytes: 1024 * 1024,
  replyBodyBytes: 768 * 1024,
  timeoutMs: [1000, 120_000],
  defaultTimeoutMs: 30_000,
  ratePerSecond: 5,
  burst: 20,
  active: 4,
  chunkBytes: 2 * 1024 * 1024,
  chunkWaitMs: 90_000,
  startWaitMs: 120_000,
  cancelWaitMs: 3000,
  maxDownloadBytes: 2 * 1024 * 1024 * 1024,
  progressGapMs: 250,
  keptEnded: 16,
  sessions: 8,
} as const;

type Bucket = { tokens: number; at: number };

const buckets = new Map<string, Bucket>();
const active = new Map<string, number>();

export function takeToken(name: string, now = Date.now()): boolean {
  const b = buckets.get(name) ?? { tokens: SITES_LIMITS.burst, at: now };
  b.tokens = Math.min(SITES_LIMITS.burst, b.tokens + ((now - b.at) / 1000) * SITES_LIMITS.ratePerSecond);
  b.at = now;
  buckets.set(name, b);
  if (b.tokens < 1 || (active.get(name) ?? 0) >= SITES_LIMITS.active) return false;
  b.tokens -= 1;
  return true;
}

export function admit(name: string): () => void {
  active.set(name, (active.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.set(name, Math.max(0, (active.get(name) ?? 1) - 1));
  };
}

export const activeSiteRequests = (name: string) => active.get(name) ?? 0;
