import { onAppEvent } from "../../platform/app";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";
import { nativeConsent } from "./nativeConsent";

const NONE = { bar_word_deletes: 0, bar_word_deletes_split_at_dot: 0, bar_word_moves: 0, bar_word_moves_split_at_dot: 0 };
let counts = { ...NONE };

export function noteBarWordEdit(consent: ConsentToken | null, kind: "delete" | "move", splitAtDot: boolean) {
  const field = kind === "delete" ? "bar_word_deletes" : "bar_word_moves";
  const split = kind === "delete" ? "bar_word_deletes_split_at_dot" : "bar_word_moves_split_at_dot";
  countFor(consent, () => {
    counts[field]++;
    if (splitAtDot) counts[split]++;
  }, splitAtDot ? { [field]: 1, [split]: 1 } : { [field]: 1 });
}

export function takeBarWordEditCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}

export const watchBarWordEdits = () => onAppEvent((e) => e.type === "barWordEdit" && noteBarWordEdit(nativeConsent(e), e.kind, e.splitAtDot));
