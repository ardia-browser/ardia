import { takeKeyHoldCounts } from "../../platform/keyHold";

let shown = 0;
let sitesShown = 0;
let restored = 0;
let held = 0;
let guardExpired = 0;
let keywordTabs = 0;

export const noteInlineCompletionShown = () => void (shown += 1);

export const noteSiteSuggestionShown = () => void (sitesShown += 1);

export const noteDroppedLetterRestored = () => void (restored += 1);

export const noteRowsHeldUnderPointer = () => void (held += 1);

export const noteReplayGuardExpired = () => void (guardExpired += 1);

export const noteKeywordTabOverCompletion = () => void (keywordTabs += 1);

export function takeInlineCompletionCounts() {
  const hold = takeKeyHoldCounts();
  const drops = Object.fromEntries(Object.entries(hold.drops).map(([reason, count]) => [`command_bar_key_hold_drops_${reason}`, count]));
  const taken = { command_bar_inline_completions: shown, command_bar_site_suggestions: sitesShown, command_bar_letters_restored: restored, command_bar_rows_held: held, command_bar_key_holds: hold.holds, command_bar_keys_replayed: hold.replayed, command_bar_replay_guards_expired: guardExpired, command_bar_keyword_tabs_over_completion: keywordTabs, ...drops };
  shown = 0;
  sitesShown = 0;
  restored = 0;
  held = 0;
  guardExpired = 0;
  keywordTabs = 0;
  return taken;
}
