import { takeEditKeyAcks } from "../../platform/focus";

const FIELDS = {
  accepted: "edit_key_acks_accepted",
  refused: "edit_key_acks_refused",
  afterHandbackAccepted: "edit_key_acks_after_handback_accepted",
  afterHandbackRefused: "edit_key_acks_after_handback_refused",
  pasteMatchStyleKeys: "paste_match_style_keys",
  pasteMatchStyleOptionKeys: "paste_match_style_option_keys",
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

export function takeEditKeyAckCounts(): Record<Field, number> {
  const raw = takeEditKeyAcks();
  const counts = {} as Record<Field, number>;
  for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
    const n = raw[key] ?? 0;
    counts[field] = Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  return counts;
}
