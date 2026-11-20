import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let closed = 0;

export function noteLiveCompletedTabsClosed(n: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (closed += n));
}

export function takeLiveCompletedTabsClosed() {
  const taken = closed;
  closed = 0;
  return taken;
}
