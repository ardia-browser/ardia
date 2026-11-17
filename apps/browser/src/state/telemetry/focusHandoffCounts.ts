import { takeFocusHandoffCounts as takeNativeCounts } from "../../platform/focus";
import { isSharing } from "./choice";

const FIELDS = {
  delivered: "focus_handoffs_delivered",
  timedOut: "focus_handoffs_timed_out",
  superseded: "focus_handoffs_superseded",
  dropped: "focus_handoff_inputs_dropped",
  pickupUnder400ms: "focus_handoff_pickups_under_400ms",
  pickup400To1000ms: "focus_handoff_pickups_400_1000ms",
  pickupOver1s: "focus_handoff_pickups_over_1s",
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

export function takeFocusHandoffCounts(): Record<Field, number> {
  const raw = takeNativeCounts();
  const shared = isSharing();
  const counts = {} as Record<Field, number>;
  for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
    const n = raw[key] ?? 0;
    counts[field] = shared && Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  return counts;
}
