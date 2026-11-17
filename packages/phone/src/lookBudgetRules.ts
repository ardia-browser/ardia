export const LOOK_BUDGET = {
  skipAfterShownMs: 1000,
  sampleMs: 3000,
  minFrames: 20,
  maxMissedShare: 0.25,
  maxBusyShare: 1 / 3,
  fewestFramesWhenBusy: 3,
  slowestRefreshMs: 1000 / 60,
  latchSlack: 1.5,
  retryAfterMs: 30 * 24 * 60 * 60 * 1000,
  quietBeforeRetryMs: 1000,
  triesPerShow: 4,
} as const;

export type FrameSample = { totals: number[]; deadlines: number[]; refreshMs?: number; windowMs?: number; foreignFrames?: number; waits?: number[]; tickMs?: number; mainThreadMs?: number; droppedReports?: number; sceneWorkerMs?: number; mainThreadMessages?: number; longestMessages?: string[]; sceneCount?: number; blendCount?: number; foreignViews?: string[] };

export type Judgement = {
  conclusive: boolean;
  over: boolean;
  frames: number;
  medianMs: number;
  deadlineMs: number;
  missedShare: number;
  refreshMs?: number;
  stretched?: number;
  windowMs?: number;
  busyShare?: number;
  paceMs?: number;
  keepsUp?: boolean;
  foreignFrames?: number;
  foreignViews?: string[];
  waitMs?: number;
  tickMs?: number;
  mainThreadMs?: number;
  wholeFrameBusyShare?: number;
  droppedReports?: number;
  sceneWorkerMs?: number;
  mainThreadMessages?: number;
  longestMessages?: string[];
  sceneCount?: number;
  blendCount?: number;
};

export type BudgetVerdict = "unknown" | "pass" | "fail";

export type BudgetState = {
  version: string;
  verdict: BudgetVerdict;
  apply: "full" | "degraded";
  measuredAt: number | null;
  pendingOver: boolean;
  last: Judgement | null;
};

export type LookMode = "full" | "no_blur" | "no_motion" | "neither";

export type SystemLook = { reduceMotion: boolean; reduceTransparency: boolean };

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export const refreshInterval = (displayMs: number | undefined): number | undefined =>
  displayMs === undefined || !(displayMs > 0) ? undefined : Math.min(displayMs, LOOK_BUDGET.slowestRefreshMs);

export function frameDeadline(ownMs: number, refreshMs: number | undefined): number {
  if (refreshMs === undefined) return ownMs;
  return ownMs > 0 && ownMs <= refreshMs * LOOK_BUDGET.latchSlack ? ownMs : refreshMs;
}

export function judge(sample: FrameSample): Judgement {
  const frames = Math.min(sample.totals.length, sample.deadlines.length);
  const totals = sample.totals.slice(0, frames);
  const refreshMs = refreshInterval(sample.refreshMs);
  const deadlines = sample.deadlines.slice(0, frames).map((own) => frameDeadline(own, refreshMs));
  const stretched = sample.deadlines.slice(0, frames).filter((own, index) => own !== deadlines[index]).length;
  const waits = (sample.waits ?? []).slice(0, frames);
  const work = totals.map((total, index) => Math.max(0, total - (waits[index] ?? 0)));
  const medianMs = median(work);
  const waitMs = waits.length === frames && frames > 0 ? median(waits) : undefined;
  const tickMs = sample.tickMs !== undefined && sample.tickMs > 0 ? sample.tickMs : 0;
  const mainThreadMs = sample.mainThreadMs !== undefined && sample.mainThreadMs > 0 ? sample.mainThreadMs : undefined;
  const betweenFrames = mainThreadMs ?? tickMs;
  const deadlineMs = median(deadlines);
  const missed = totals.filter((total, index) => total > deadlines[index]!).length;
  const missedShare = frames === 0 ? 0 : missed / frames;
  const windowMs = sample.windowMs !== undefined && sample.windowMs > 0 ? sample.windowMs : LOOK_BUDGET.sampleMs;
  const sceneWorkerMs = sample.sceneWorkerMs !== undefined && sample.sceneWorkerMs > 0 ? sample.sceneWorkerMs : 0;
  const busyShare = (work.reduce((sum, spent) => sum + spent, 0) + betweenFrames + sceneWorkerMs) / windowMs;
  const wholeFrameBusyShare = totals.reduce((sum, total) => sum + total, 0) / windowMs;
  const paceMs = frames === 0 ? windowMs : windowMs / frames;
  const keepsUp = medianMs <= paceMs;
  const tooBusy = busyShare > LOOK_BUDGET.maxBusyShare;
  const foreignFrames = sample.foreignFrames ?? 0;
  const droppedReports = sample.droppedReports ?? 0;
  const conclusive = foreignFrames === 0 && droppedReports === 0 && (frames >= LOOK_BUDGET.minFrames || (frames >= LOOK_BUDGET.fewestFramesWhenBusy && (tooBusy || !keepsUp)));
  const over = conclusive && (tooBusy || !keepsUp);
  return { conclusive, over, frames, medianMs, deadlineMs, missedShare, ...(refreshMs === undefined ? {} : { refreshMs, stretched }), windowMs, busyShare, paceMs, keepsUp, ...(foreignFrames > 0 ? { foreignFrames, ...(sample.foreignViews?.length ? { foreignViews: sample.foreignViews } : {}) } : {}), ...(waitMs !== undefined ? { waitMs, wholeFrameBusyShare } : {}), ...(tickMs > 0 ? { tickMs } : {}), ...(mainThreadMs !== undefined ? { mainThreadMs } : {}), ...(droppedReports > 0 ? { droppedReports } : {}), ...(sceneWorkerMs > 0 ? { sceneWorkerMs } : {}), ...(sample.mainThreadMessages !== undefined ? { mainThreadMessages: sample.mainThreadMessages } : {}), ...(sample.longestMessages?.length ? { longestMessages: sample.longestMessages.slice(0, 3) } : {}), ...(sample.sceneCount !== undefined ? { sceneCount: sample.sceneCount } : {}), ...(sample.blendCount !== undefined ? { blendCount: sample.blendCount } : {}) };
}

export const initialState = (version: string): BudgetState => ({ version, verdict: "unknown", apply: "full", measuredAt: null, pendingOver: false, last: null });

export function refresh(state: BudgetState | null, version: string, now: number): BudgetState {
  if (!state) return initialState(version);
  const updated = state.version !== version;
  if (state.verdict === "fail" && state.apply === "degraded" && (updated || (state.measuredAt !== null && now - state.measuredAt >= LOOK_BUDGET.retryAfterMs))) {
    return { ...state, version, apply: "full", pendingOver: false };
  }
  if (state.verdict === "pass" && updated) return { ...state, version, verdict: "unknown", apply: "full", pendingOver: false };
  return updated ? { ...state, version } : state;
}

export const wantsMeasurement = (state: BudgetState, system: SystemLook): boolean =>
  state.apply === "full" && state.verdict !== "pass" && !system.reduceMotion;

export function record(state: BudgetState, judgement: Judgement, now: number): BudgetState {
  if (!judgement.conclusive) return state;
  if (!judgement.over) return { ...state, verdict: "pass", apply: "full", measuredAt: now, pendingOver: false, last: judgement };
  if (!state.pendingOver) return { ...state, pendingOver: true, last: judgement };
  return { ...state, verdict: "fail", apply: "degraded", measuredAt: now, pendingOver: false, last: judgement };
}

export function mode(applied: "full" | "degraded", system: SystemLook): LookMode {
  const noBlur = applied === "degraded" || system.reduceTransparency;
  const noMotion = applied === "degraded" || system.reduceMotion;
  if (noBlur && noMotion) return "neither";
  if (noBlur) return "no_blur";
  if (noMotion) return "no_motion";
  return "full";
}

export function parseState(text: string | null | undefined): BudgetState | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<BudgetState>;
    if (typeof value.version !== "string" || (value.apply !== "full" && value.apply !== "degraded")) return null;
    if (value.verdict !== "unknown" && value.verdict !== "pass" && value.verdict !== "fail") return null;
    return {
      version: value.version,
      verdict: value.verdict,
      apply: value.apply,
      measuredAt: typeof value.measuredAt === "number" ? value.measuredAt : null,
      pendingOver: value.pendingOver === true,
      last: value.last ?? null,
    };
  } catch {
    return null;
  }
}

export type ProbeDeps = {
  sample: (millis: number) => Promise<FrameSample | null>;
  schedule: (run: () => void, millis: number) => () => void;
  record: (sample: FrameSample, attempt: ProbeAttempt) => void;
  cancelSample?: () => void;
};

export type ProbeAttempt = { tries: number; retrying: boolean };

export function createBudgetProbe(deps: ProbeDeps) {
  let measured = false;
  let generation = 0;
  let cancel: (() => void) | null = null;
  let sampling = false;
  const stop = () => {
    generation += 1;
    cancel?.();
    cancel = null;
    if (sampling) {
      sampling = false;
      deps.cancelSample?.();
    }
  };
  return {
    update(idle: boolean, wanted: boolean) {
      stop();
      if (measured || !idle || !wanted) return;
      const mine = generation;
      const attempt = (tries: number, wait: number) => {
        cancel = deps.schedule(() => {
          sampling = true;
          deps.sample(LOOK_BUDGET.sampleMs).then(
            (sample) => {
              if (mine === generation) sampling = false;
              if (mine !== generation || measured || !sample) return;
              const retrying = (sample.foreignFrames ?? 0) > 0 && tries < LOOK_BUDGET.triesPerShow;
              if (!retrying) measured = true;
              deps.record(sample, { tries, retrying });
              if (retrying) attempt(tries + 1, LOOK_BUDGET.quietBeforeRetryMs);
            },
            () => {
              if (mine === generation) sampling = false;
            },
          );
        }, wait);
      };
      attempt(1, LOOK_BUDGET.skipAfterShownMs);
    },
    stop,
    get measured() {
      return measured;
    },
  };
}

export function otherWork(last: Judgement): string {
  const total = last.mainThreadMs ?? 0;
  const ticks = last.tickMs ?? 0;
  const messages = last.mainThreadMessages !== undefined ? ` in ${last.mainThreadMessages} message(s)` : "";
  const split = `: backdrop ticks ${ticks.toFixed(1)} ms, the rest ${Math.max(0, total - ticks).toFixed(1)} ms`;
  const longest = last.longestMessages?.length ? `; longest ${last.longestMessages.join(", ")}` : "";
  return `${total.toFixed(1)} ms${messages}${split}${longest}`;
}
