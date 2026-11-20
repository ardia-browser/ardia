import type { CaptureResult } from "../../platform/tabs";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NONE = { started: 0, areas: 0, cancelled: 0, failed: 0, saved: 0 };
let counts = { ...NONE };

export const noteCaptureStarted = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.started++);

export const noteCaptureSaved = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.saved++);

export function noteCaptureEnded({ outcome }: CaptureResult, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void counts[outcome === "copied" ? "areas" : outcome]++);
}

export function takeCaptureCounts() {
  const taken = counts;
  counts = { ...NONE };
  return { captures_started: taken.started, captures_of_areas: taken.areas, captures_cancelled: taken.cancelled, captures_failed: taken.failed, captures_saved: taken.saved };
}
