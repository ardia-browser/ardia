import { save, savedChoice } from "./choice";
import { uuidv4 } from "./ids";
import { telemetryRelay } from "./relay";

export function adoptInstallId(installId: string): string {
  const current = savedChoice();
  if (current.installId) return current.installId;
  save({ sharing: false, installId });
  return installId;
}

export function ensureInstallId(): string {
  const known = savedChoice().installId;
  if (known) return known;
  const relay = telemetryRelay();
  return relay ? relay.installId() : adoptInstallId(uuidv4());
}
