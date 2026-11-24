import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let shown = 0;
let otherProfile = 0;

export function noteStripHoverCard(fromOtherProfile: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (shown++, fromOtherProfile && otherProfile++));
}

export function takeStripHoverCardCounts() {
  const taken = { tab_strip_hover_cards: shown, tab_strip_hover_cards_other_profile: otherProfile };
  shown = 0;
  otherProfile = 0;
  return taken;
}
