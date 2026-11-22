import { useEffect, useRef } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";
import { createBudgetProbe, judge, LOOK_BUDGET, mode, parseState, record, refresh, wantsMeasurement, otherWork, type BudgetState, type FrameSample, type LookMode, type ProbeAttempt, type SystemLook } from "./lookBudgetRules";
import { labLog } from "./system";

type BudgetNative = {
  lookBudget?: () => { state: string | null; version: string; forced: string | null };
  setLookBudget?: (state: string) => void;
  forceLookBudget?: (applied: string | null) => void;
  sampleFrames?: (millis: number) => Promise<FrameSample | null>;
  cancelSampleFrames?: () => void;
};

const native = requireOptionalNativeModule<BudgetNative>("ArdiaPhoneLook");

let current: BudgetState | null = null;
let appliedAtLaunch: "full" | "degraded" = "full";

function load(now = Date.now()): BudgetState | null {
  const stored = native?.lookBudget?.();
  if (!stored) return null;
  const fresh = refresh(parseState(stored.state), stored.version, now);
  if (JSON.stringify(fresh) !== stored.state) native?.setLookBudget?.(JSON.stringify(fresh));
  return fresh;
}

function state(): BudgetState | null {
  if (current) return current;
  current = load();
  appliedAtLaunch = current?.apply ?? "full";
  return current;
}

function save(next: BudgetState) {
  current = next;
  native?.setLookBudget?.(JSON.stringify(next));
}

const refreshNote = (last: NonNullable<BudgetState["last"]>) =>
  last.refreshMs === undefined ? "" : ` (display ${Math.round(1000 / last.refreshMs)} Hz${last.stretched ? `, ${last.stretched} stretched deadline(s) held to ${last.refreshMs.toFixed(1)} ms` : ""})`;

const percent = (share: number) => `${Math.round(share * 100)}%`;


const dutyNote = (last: NonNullable<BudgetState["last"]>) =>
  last.busyShare === undefined || last.paceMs === undefined || last.windowMs === undefined
    ? ""
    : `${last.waitMs !== undefined ? ` of work (${last.waitMs.toFixed(1)} ms waiting for the vsync not counted)` : ""}${last.mainThreadMs !== undefined ? `, other main-thread work ${otherWork(last)}` : last.tickMs ? ` (backdrop ticks ${last.tickMs.toFixed(1)} ms)` : ""}${last.sceneWorkerMs ? `, the backdrop's ${last.sceneCount !== undefined ? `${last.sceneCount} scene(s)${last.blendCount ? ` and ${last.blendCount} blend(s)` : ""} ` : "scenes "}drawn off the main thread in ${last.sceneWorkerMs.toFixed(1)} ms (counted)` : ""}, busy ${percent(last.busyShare)} of the time${last.wholeFrameBusyShare !== undefined ? ` (whole frames, as judged through sync17b: ${percent(last.wholeFrameBusyShare)})` : ""} (limit ${percent(LOOK_BUDGET.maxBusyShare)}), one frame every ${last.paceMs.toFixed(0)} ms over ${(last.windowMs / 1000).toFixed(1)} s, ${last.keepsUp ? "keeps up" : "cannot keep up: the median frame is longer than the pace"}`;

const describe = (next: BudgetState) =>
  `verdict ${next.verdict}, next build ${next.apply}${next.pendingOver ? ", one failing measurement waiting for a second" : ""}` +
  (next.last ? `, last ${next.last.frames} frames, median ${next.last.medianMs.toFixed(1)} ms${dutyNote(next.last)}; against the display's deadline ${next.last.deadlineMs.toFixed(1)} ms${refreshNote(next.last)}, ${percent(next.last.missedShare)} missed (not judged)` : "");


export const lookBudget = {
  isNative: () => typeof native?.sampleFrames === "function",
  state: (): BudgetState | null => state(),
  mode: (system: SystemLook): LookMode => {
    state();
    return mode(appliedAtLaunch, system);
  },
  describe: (): string => {
    const now = state();
    const forced = native?.lookBudget?.().forced ?? null;
    return now ? `${describe(now)}${forced ? `; lab forces ${forced}` : ""}` : "no budget (no native look)";
  },
  force: (applied: "full" | "degraded" | null) => native?.forceLookBudget?.(applied),
  reset: () => {
    const stored = native?.lookBudget?.();
    if (!stored) return;
    save(refresh(null, stored.version, Date.now()));
  },
  recordSample: (sample: FrameSample, now = Date.now(), attempt?: ProbeAttempt): BudgetState | null => {
    const before = state();
    if (!before) return null;
    const judgement = judge(sample);
    const next = record(before, judgement, now);
    save(next);
    const why = judgement.conclusive
      ? ""
      : judgement.foreignFrames
        ? ` (this sample dropped: ${judgement.foreignFrames} frame(s) drawn by something other than the backdrop${judgement.foreignViews?.length ? `: ${judgement.foreignViews.join(", ")}` : ""}${attempt ? (attempt.retrying ? `; trying again after a quiet second, try ${attempt.tries + 1} of ${LOOK_BUDGET.triesPerShow}` : `; try ${attempt.tries} of ${LOOK_BUDGET.triesPerShow}, no more tries until the deck shows again`) : ""})`
        : judgement.droppedReports
          ? ` (this sample dropped: ${judgement.droppedReports} frame report(s) lost)`
          : ` (this sample dropped: ${judgement.frames} frame(s), too few)`;
    labLog(`PAGELAB look budget ${judgement.conclusive ? (judgement.over ? "over" : "within") : "inconclusive"}${why}: ${describe(next)}`);
    return next;
  },
};

export function useLookBudgetProbe(idle: boolean, system: SystemLook) {
  const probe = useRef<ReturnType<typeof createBudgetProbe> | null>(null);
  probe.current ??= createBudgetProbe({
    sample: (millis) => native?.sampleFrames?.(millis) ?? Promise.resolve(null),
    cancelSample: () => native?.cancelSampleFrames?.(),
    schedule: (run, millis) => {
      const timer = setTimeout(run, millis);
      return () => clearTimeout(timer);
    },
    record: (sample, attempt) => void lookBudget.recordSample(sample, Date.now(), attempt),
  });
  useEffect(() => {
    const now = state();
    probe.current?.update(idle, !!now && !!native?.sampleFrames && wantsMeasurement(now, system));
  }, [idle, system.reduceMotion]);
  useEffect(() => () => probe.current?.stop(), []);
}
