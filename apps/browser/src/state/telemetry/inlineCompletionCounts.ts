import { takeKeyHoldCounts } from "../../platform/keyHold";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let shown = 0;
let kept = 0;
let sitesShown = 0;
let routesListed = 0;
let restored = 0;
let held = 0;
let heldKeyMoves = 0;
let guardExpired = 0;
let openRelayouts = 0;
let lateBelow = 0;
let chances = 0;
let misses = 0;
let keyDismissals = 0;

export const noteInlineCompletionShown = () => void (shown += 1);

export const noteInlineCompletionKept = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (kept += 1));

export const noteSiteSuggestionShown = () => void (sitesShown += 1);

export const noteInlineChance = (missed: boolean, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void ((chances += 1), missed && (misses += 1)));

export const noteRoutesListed = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (routesListed += 1));

export const noteDroppedLetterRestored = () => void (restored += 1);

export const noteRowsHeldUnderPointer = () => void (held += 1);

export const noteHeldRowsKeyMove = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (heldKeyMoves += 1));

export const noteLateSuggestionsBelow = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (lateBelow += 1));

export const noteCommandBarOpenRelayout = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (openRelayouts += 1));

export const noteCommandBarKeyDismissal = (consent: ConsentToken | null) => countFor(consent, () => void (keyDismissals += 1));

export const noteReplayGuardExpired = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (guardExpired += 1));

export function takeInlineCompletionCounts() {
  const hold = takeKeyHoldCounts();
  const drops = Object.fromEntries(Object.entries(hold.drops).map(([reason, count]) => [`command_bar_key_hold_drops_${reason}`, count]));
  const taken = { command_bar_inline_completions: shown, command_bar_inline_completions_kept: kept, command_bar_site_suggestions: sitesShown, command_bar_routes_listed: routesListed, command_bar_letters_restored: restored, command_bar_rows_held: held, command_bar_held_rows_key_moves: heldKeyMoves, command_bar_key_holds: hold.holds, command_bar_keys_replayed: hold.replayed, command_bar_replay_guards_expired: guardExpired, command_bar_open_relayouts: openRelayouts, command_bar_late_suggestions_below: lateBelow, command_bar_inline_chances: chances, command_bar_inline_misses: misses, command_bar_key_dismissals: keyDismissals, ...drops };
  shown = 0;
  kept = 0;
  sitesShown = 0;
  routesListed = 0;
  restored = 0;
  held = 0;
  heldKeyMoves = 0;
  guardExpired = 0;
  openRelayouts = 0;
  lateBelow = 0;
  chances = 0;
  misses = 0;
  keyDismissals = 0;
  return taken;
}
