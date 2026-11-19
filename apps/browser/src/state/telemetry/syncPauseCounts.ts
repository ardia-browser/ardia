import { onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor } from "./countFor";

const NONE = { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 };

export type SyncPauseStep = keyof typeof NONE;

let counts = { ...NONE };

onConsentPeriodChange(() => (counts = { ...NONE }));

export const noteSyncPause = (step: SyncPauseStep, consent: ConsentToken | null) => countFor(consent, () => void (counts[step] += 1), { [step]: 1 });

export function takeSyncPauseCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
