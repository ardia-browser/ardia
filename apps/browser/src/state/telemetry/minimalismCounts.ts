import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let turnedOn = 0;
let turnedOff = 0;
const pinnedIcons = { letters: 0, logos: 0 };
const tileLetters = { set: 0, reset: 0 };

export function noteMinimalismToggled(on: boolean) {
  if (on) turnedOn++;
  else turnedOff++;
}

export function noteMinimalismPinnedIcons(choice: keyof typeof pinnedIcons, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void pinnedIcons[choice]++);
}

export function noteTileLetters(change: keyof typeof tileLetters, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void tileLetters[change]++);
}

export function takeMinimalismCounts() {
  const taken = {
    minimalism_turned_on: turnedOn,
    minimalism_turned_off: turnedOff,
    minimalism_pinned_icons_letters: pinnedIcons.letters,
    minimalism_pinned_icons_logos: pinnedIcons.logos,
    tile_letters_set: tileLetters.set,
    tile_letters_reset: tileLetters.reset,
  };
  turnedOn = 0;
  turnedOff = 0;
  pinnedIcons.letters = 0;
  pinnedIcons.logos = 0;
  tileLetters.set = 0;
  tileLetters.reset = 0;
  return taken;
}
