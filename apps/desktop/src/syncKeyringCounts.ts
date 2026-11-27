import type { SyncKeyStoreStatus } from "./hostSync.ts";
import { noteKeyringFailure } from "../../browser/src/state/telemetry/keyringCounts";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice";
import { stillValid } from "../../browser/src/state/telemetry/consentPeriod";

type KeyringFailure = "locked" | "unavailable";

let lastFailure: KeyringFailure | null = null;

const closed = (state: SyncKeyStoreStatus["keyStoreStatus"] | undefined): state is KeyringFailure => state === "locked" || state === "unavailable";

function keyringFailure(status: SyncKeyStoreStatus | null): KeyringFailure | null {
  if (status?.keyStore !== "secretService") return null;
  if (closed(status.keyStoreStatus)) return status.keyStoreStatus;
  return closed(status.lastKeyStatus) ? status.lastKeyStatus : null;
}

export function noteSyncKeyStore(status: SyncKeyStoreStatus | null, consent: ConsentToken | null) {
  if (!status) {
    lastFailure = null;
    return;
  }
  if (!stillValid(consent)) return;
  const failed = keyringFailure(status);
  const before = lastFailure;
  lastFailure = failed;
  if (failed && failed !== before) noteKeyringFailure("sync", failed, consent);
}

export function keyringObserver(read: () => Promise<SyncKeyStoreStatus>, consentNow: () => ConsentToken | null) {
  let askConsent: ConsentToken | null = null;
  return {
    status: () => {
      askConsent = consentNow();
      return read();
    },
    note: (status: SyncKeyStoreStatus) => noteSyncKeyStore(status, askConsent),
  };
}
