import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let shown = 0;
let otherProfile = 0;

export function noteStripHoverCard(fromOtherProfile: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (shown++, fromOtherProfile && otherProfile++), { tab_strip_hover_cards: 1, tab_strip_hover_cards_other_profile: +fromOtherProfile });
}

export function takeStripHoverCardCounts() {
  const taken = { tab_strip_hover_cards: shown, tab_strip_hover_cards_other_profile: otherProfile };
  shown = 0;
  otherProfile = 0;
  return taken;
}
