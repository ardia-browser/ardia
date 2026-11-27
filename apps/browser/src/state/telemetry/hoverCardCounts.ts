import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NONE = { tab_hover_cards_shown: 0, tab_hover_card_presses: 0, tab_hover_card_resets: 0, tab_menu_pinned_resets: 0, tab_hover_players_skipped_before_playback: 0 };
let counts = { ...NONE };

export const noteTabHoverCardShown = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.tab_hover_cards_shown++);

export const noteTabHoverPlayerSkippedBeforePlayback = (consent: ConsentToken) => countFor(consent, () => void counts.tab_hover_players_skipped_before_playback++);

export function noteTabHoverCardPress(reset: boolean) {
  counts.tab_hover_card_presses++;
  if (reset) counts.tab_hover_card_resets++;
}

export const noteTabMenuPinnedReset = () => void counts.tab_menu_pinned_resets++;

export function takeHoverCardCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
