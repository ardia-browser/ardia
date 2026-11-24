import { onConsentPeriodChange } from "./choice";
import { consentToken, countFor } from "./consentPeriod";

const STUTTER_GAP_MS = 34;
const OVERRUN_MS = 50;
const TIMED_FOR_MS = 1000;

let folds = 0;
let stutters = 0;
let overruns = 0;

type FoldTiming = { end: (finished: boolean) => void };

const UNTIMED: FoldTiming = { end: () => {} };

export function noteFoldMotion(plannedMs: number): FoldTiming {
  const consent = consentToken();
  if (!consent || typeof requestAnimationFrame !== "function") return UNTIMED;
  const startedAt = Date.now();
  let last = startedAt;
  let worstGap = 0;
  let frame = requestAnimationFrame(function tick() {
    const now = Date.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    frame = now - startedAt < TIMED_FOR_MS ? requestAnimationFrame(tick) : 0;
  });
  return {
    end: (finished) => {
      cancelAnimationFrame(frame);
      if (!finished) return;
      const took = Date.now() - startedAt;
      countFor(consent, () => {
        folds++;
        if (Math.max(worstGap, Date.now() - last) > STUTTER_GAP_MS) stutters++;
        if (took > plannedMs + OVERRUN_MS) overruns++;
      });
    },
  };
}

function clearFoldMotionCounts() {
  folds = 0;
  stutters = 0;
  overruns = 0;
}

onConsentPeriodChange(clearFoldMotionCounts);

export function takeFoldMotionCounts() {
  const taken = { sidebar_folds: folds, sidebar_fold_stutters: stutters, sidebar_fold_overruns: overruns };
  clearFoldMotionCounts();
  return taken;
}
