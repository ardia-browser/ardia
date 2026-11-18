import { onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor } from "./countFor";

export type PushMessagingTotals = { subscribed: number; subscribeFailed: number; subscribeRefusedOff: number; delivered: number };

const KINDS = ["subscribed", "subscribeFailed", "subscribeRefusedOff", "delivered"] as const;
const none = (): PushMessagingTotals => ({ subscribed: 0, subscribeFailed: 0, subscribeRefusedOff: 0, delivered: 0 });

const fieldsOf = (totals: PushMessagingTotals) => ({
  push_subscribes: totals.subscribed,
  push_subscribe_failures: totals.subscribeFailed,
  push_subscribes_refused_off: totals.subscribeRefusedOff,
  push_messages_delivered: totals.delivered,
});

let seen: PushMessagingTotals | null = none();
let counts = none();

onConsentPeriodChange(() => {
  seen = null;
  counts = none();
});

export function notePushMessaging(totals: Partial<PushMessagingTotals> | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const previous = seen;
  const next = none();
  const added = none();
  for (const kind of KINDS) {
    const total = Math.max(0, Number(totals[kind]) || 0);
    next[kind] = Math.max(total, previous?.[kind] ?? 0);
    if (previous) added[kind] = Math.max(0, total - previous[kind]);
  }
  seen = next;
  if (KINDS.some((kind) => added[kind])) countFor(consent, () => KINDS.forEach((kind) => (counts[kind] += added[kind])), fieldsOf(added));
}

export function takePushMessagingCounts() {
  const taken = counts;
  counts = none();
  return fieldsOf(taken);
}
