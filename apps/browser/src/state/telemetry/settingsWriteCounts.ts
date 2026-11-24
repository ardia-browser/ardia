import { consentOrNow, countFor } from "./countFor";

let rejected = 0;

export const noteSettingsWritesRejected = (count: number) => countFor(consentOrNow(undefined), () => void (rejected += count));

export function takeSettingsWriteCounts() {
  const taken = { settings_writes_rejected: rejected };
  rejected = 0;
  return taken;
}
