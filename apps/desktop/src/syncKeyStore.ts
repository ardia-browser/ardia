import type { SyncKeyStoreStatus } from "./hostSync.ts";
import { syncKeyStoreMessage } from "@platform/secretWording";

export { SYNC_KEY_NOT_SAVED } from "@platform/secretWording";

export function keyringMessage(status: SyncKeyStoreStatus | null, saving: boolean): string | null {
  const state = saving ? status?.lastKeyStatus ?? status?.keyStoreStatus : status?.keyStoreStatus;
  return syncKeyStoreMessage(status?.keyStore, state, saving);
}

export function presentSyncState<S extends { status: string; error: string | null }>(state: S, status: SyncKeyStoreStatus | null): S {
  if (state.status !== "locked") return state;
  const message = keyringMessage(status, false);
  return message ? { ...state, error: message } : state;
}
