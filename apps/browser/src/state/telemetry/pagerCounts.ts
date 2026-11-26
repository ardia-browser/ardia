import { counted, type ConsentToken } from "./choice";

let settles = 0;
let settlesWithoutSwitch = 0;
let dotReorders = 0;
let switchesAfterRest = 0;
let restsSeenByWatch = 0;
let settlesSampled = 0;
let settleFrames = 0;
let settleLongFrames = 0;
let settlesWithLongFrames = 0;
let settleWorstGapMs = 0;

export function notePagerSettle(switched: boolean) {
  settles++;
  if (!switched) settlesWithoutSwitch++;
}

export const noteProfileDotReorder = () => void dotReorders++;

export const notePagerSwitchAfterRest = (consent: ConsentToken | null) => counted(consent, () => void switchesAfterRest++);

export const notePagerRestSeenByWatch = (consent: ConsentToken | null) => counted(consent, () => void restsSeenByWatch++);

export type SettleFrames = { frames?: number; longFrames?: number; worstGapMs?: number };

export const notePagerSettleFrames = ({ frames, longFrames, worstGapMs }: SettleFrames, consent: ConsentToken | null) =>
  counted(consent, () => {
    if (typeof frames !== "number" || typeof longFrames !== "number") return;
    settlesSampled++;
    settleFrames += frames;
    settleLongFrames += longFrames;
    if (longFrames > 0) settlesWithLongFrames++;
    if (typeof worstGapMs === "number") settleWorstGapMs = Math.max(settleWorstGapMs, Math.round(worstGapMs));
  });

export function takePagerCounts() {
  const taken = {
    profile_pager_settles: settles,
    profile_pager_settles_without_switch: settlesWithoutSwitch,
    profile_dot_reorders: dotReorders,
    profile_pager_switches_after_rest: switchesAfterRest,
    profile_pager_rests_seen_by_watch: restsSeenByWatch,
    profile_pager_settles_sampled: settlesSampled,
    profile_pager_settle_frames: settleFrames,
    profile_pager_settle_long_frames: settleLongFrames,
    profile_pager_settles_with_long_frames: settlesWithLongFrames,
    profile_pager_settle_worst_gap_ms: settleWorstGapMs,
  };
  settles = 0;
  settlesWithoutSwitch = 0;
  dotReorders = 0;
  switchesAfterRest = 0;
  restsSeenByWatch = 0;
  settlesSampled = 0;
  settleFrames = 0;
  settleLongFrames = 0;
  settlesWithLongFrames = 0;
  settleWorstGapMs = 0;
  return taken;
}
