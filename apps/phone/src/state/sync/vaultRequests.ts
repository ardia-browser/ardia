import type { SyncedView } from "../../platform/sync";

export type VaultRequest = NonNullable<SyncedView["vaultRequests"]>[number];

export function nextVaultRequest(requests: VaultRequest[] | undefined, setAside: ReadonlySet<string>, now: number): VaultRequest | null {
  return (requests ?? []).find((r) => r.expiresAt > now && !setAside.has(r.id)) ?? null;
}

export function siteName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function timeLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function askedBy(request: VaultRequest): string {
  const mac = request.fromDevice?.trim() || "your Mac";
  return request.profileName ? `${mac} · ${request.profileName}` : mac;
}

export const sheetLatencyMs = (request: VaultRequest, shownAt: number) => Math.max(0, Math.round(shownAt - request.askedAt));
