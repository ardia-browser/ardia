export const PENDING_TOTP_MS = 3 * 60_000;

export type PendingTotp = { origin: string; tabId: string; provider: string; id: string; at: number };

const livePending = (list: readonly PendingTotp[], now: number) => list.filter((p) => now - p.at < PENDING_TOTP_MS && now >= p.at);

export const rememberPending = (list: readonly PendingTotp[], entry: PendingTotp): PendingTotp[] => [
  ...livePending(list, entry.at).filter((p) => p.tabId !== entry.tabId),
  entry,
];

export function pendingFor(list: readonly PendingTotp[], origin: string, tabId: string | null, now: number): PendingTotp | null {
  if (!tabId) return null;
  const live = livePending(list, now).filter((p) => p.tabId === tabId && p.origin === origin);
  return live.sort((a, b) => b.at - a.at)[0] ?? null;
}

export const forgetPending = (list: readonly PendingTotp[], provider?: string) => (provider ? list.filter((p) => p.provider !== provider) : []);

export const keepListedPending = (list: readonly PendingTotp[], provider: string, listed: ReadonlySet<string>): PendingTotp[] =>
  list.filter((p) => p.provider !== provider || listed.has(p.id));
