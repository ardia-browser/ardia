import { counted, type ConsentToken } from "./choice";

let settles = 0;
let settlesWithoutSwitch = 0;
let dotReorders = 0;
let switchesAfterRest = 0;
let restsSeenByWatch = 0;

export function notePagerSettle(switched: boolean) {
  settles++;
  if (!switched) settlesWithoutSwitch++;
}

export const noteProfileDotReorder = () => void dotReorders++;

export const notePagerSwitchAfterRest = (consent: ConsentToken | null) => counted(consent, () => void switchesAfterRest++);

export const notePagerRestSeenByWatch = (consent: ConsentToken | null) => counted(consent, () => void restsSeenByWatch++);

export function takePagerCounts() {
  const taken = {
    profile_pager_settles: settles,
    profile_pager_settles_without_switch: settlesWithoutSwitch,
    profile_dot_reorders: dotReorders,
    profile_pager_switches_after_rest: switchesAfterRest,
    profile_pager_rests_seen_by_watch: restsSeenByWatch,
  };
  settles = 0;
  settlesWithoutSwitch = 0;
  dotReorders = 0;
  switchesAfterRest = 0;
  restsSeenByWatch = 0;
  return taken;
}
