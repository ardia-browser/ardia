import { takeHoverCounts as takeNativeCounts } from "../../platform/focus";
import { stillValid, type ConsentToken } from "./client";

const FIELDS = { holds: "hover_holds_over_300ms", clipped: "hover_clipped_enters" } as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

export function takeHoverCounts(): Record<Field, number> {
  const sent = { hover_holds_over_300ms: 0, hover_clipped_enters: 0 };
  for (const [epoch, raw] of Object.entries(takeNativeCounts())) {
    if (!stillValid(epoch as ConsentToken)) continue;
    for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
      const n = raw?.[key] ?? 0;
      if (Number.isSafeInteger(n) && n > 0) sent[field] += n;
    }
  }
  return sent;
}
