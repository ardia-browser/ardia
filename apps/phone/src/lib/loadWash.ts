export const LOAD_WASH = {
  revealDelayMs: 120,
  fadeInMs: 150,
  chaseResponse: 0.42,
  startShare: 0.08,
  trickleReach: 0.1,
  trickleCeiling: 0.9,
  trickleMs: 1600,
  finishMs: 200,
  fadeOutMs: 280,
  clearMs: 90,
  longestFrameMs: 64,
  settleShare: 0.001,
} as const;

export type WashPhase = "idle" | "waiting" | "showing" | "finishing" | "fading" | "clearing";

export type WashInput = { progress: number; loading: boolean; snap: number; trickles: boolean; reduced: boolean };

export type WashState = { phase: WashPhase; clock: number; fill: number; velocity: number; creep: number; alpha: number; from: number; fromAlpha: number; snap: number; revealed: boolean };

export const IDLE_WASH: WashState = { phase: "idle", clock: 0, fill: 0, velocity: 0, creep: 0, alpha: 0, from: 0, fromAlpha: 0, snap: 0, revealed: false };

export const IDLE_WASH_INPUT: WashInput = { progress: 0, loading: false, snap: 0, trickles: true, reduced: false };

const unit = (value: number) => {
  "worklet";
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
};

const easeOutCubic = (t: number) => {
  "worklet";
  return 1 - (1 - t) ** 3;
};

const smoothstep = (t: number) => {
  "worklet";
  return t * t * (3 - 2 * t);
};

export function washFloor(input: WashInput): number {
  "worklet";
  const progress = unit(input.progress);
  return input.trickles ? Math.max(progress, LOAD_WASH.startShare) : progress;
}

export function washCeiling(input: WashInput): number {
  "worklet";
  const floor = washFloor(input);
  return input.trickles ? Math.max(floor, Math.min(LOAD_WASH.trickleCeiling, floor + LOAD_WASH.trickleReach)) : floor;
}

export function snappedWash(input: WashInput): WashState {
  "worklet";
  if (!input.loading || unit(input.progress) < LOAD_WASH.startShare) return { ...IDLE_WASH, snap: input.snap };
  const fill = input.reduced ? 1 : washFloor(input);
  return { ...IDLE_WASH, phase: "showing", clock: LOAD_WASH.fadeInMs, fill, creep: fill, alpha: 1, snap: input.snap };
}

function chased(state: WashState, input: WashInput, seconds: number): WashState {
  "worklet";
  if (input.reduced) return { ...state, fill: 1, velocity: 0, creep: 1 };
  const floor = washFloor(input);
  const ceiling = washCeiling(input);
  let creep = Math.max(state.creep, floor);
  if (creep < ceiling) creep = ceiling - (ceiling - creep) * Math.exp((-seconds * 1000) / LOAD_WASH.trickleMs);
  creep = unit(creep);
  const omega = (2 * Math.PI) / LOAD_WASH.chaseResponse;
  const decay = Math.exp(-omega * seconds);
  const gap = state.fill - creep;
  const drive = state.velocity + omega * gap;
  const nextGap = (gap + drive * seconds) * decay;
  const nextVelocity = (state.velocity - omega * drive * seconds) * decay;
  const fill = unit(Math.max(state.fill, creep + nextGap));
  return { ...state, creep, fill, velocity: fill > state.fill ? Math.max(nextVelocity, 0) : 0 };
}

const reset = (state: WashState, phase: WashPhase): WashState => {
  "worklet";
  return { ...IDLE_WASH, phase, snap: state.snap };
};

export function stepWash(was: WashState, input: WashInput, elapsedMs: number): WashState {
  "worklet";
  if (input.snap !== was.snap) return snappedWash(input);
  const dt = Math.min(Math.max(Number.isFinite(elapsedMs) ? elapsedMs : 0, 0), LOAD_WASH.longestFrameMs);
  const seconds = dt / 1000;
  const state: WashState = { ...was, revealed: false };
  const fadeIn = (alpha: number) => {
    "worklet";
    return Math.min(1, alpha + dt / LOAD_WASH.fadeInMs);
  };
  if (state.phase === "idle") return input.loading ? chased(reset(state, "waiting"), input, 0) : state;
  if (state.phase === "waiting") {
    if (!input.loading) return reset(state, "idle");
    const clock = state.clock + dt;
    const moved = chased({ ...state, clock }, input, seconds);
    return clock >= LOAD_WASH.revealDelayMs ? { ...moved, phase: "showing", clock: 0, revealed: true } : moved;
  }
  if (state.phase === "showing") {
    const alpha = fadeIn(state.alpha);
    if (input.loading) return { ...chased(state, input, seconds), alpha };
    if (input.reduced) return { ...state, phase: "fading", clock: 0, fill: 1, alpha, fromAlpha: alpha };
    return { ...state, phase: "finishing", clock: 0, alpha, from: state.fill, velocity: 0 };
  }
  if (state.phase === "finishing") {
    if (input.loading) return { ...state, phase: "clearing", clock: 0, fromAlpha: state.alpha };
    const clock = state.clock + dt;
    const t = Math.min(1, clock / LOAD_WASH.finishMs);
    const fill = state.from + (1 - state.from) * easeOutCubic(t);
    const alpha = fadeIn(state.alpha);
    return t >= 1 ? { ...state, phase: "fading", clock: 0, fill: 1, alpha, fromAlpha: alpha } : { ...state, clock, fill, alpha };
  }
  if (state.phase === "fading") {
    if (input.loading) return { ...state, phase: "clearing", clock: 0, fromAlpha: state.alpha };
    const clock = state.clock + dt;
    const t = Math.min(1, clock / LOAD_WASH.fadeOutMs);
    return t >= 1 ? reset(state, "idle") : { ...state, clock, alpha: state.fromAlpha * (1 - smoothstep(t)) };
  }
  const clock = state.clock + dt;
  const t = Math.min(1, clock / LOAD_WASH.clearMs);
  if (t >= 1) return reset(state, input.loading ? "waiting" : "idle");
  return { ...state, clock, alpha: state.fromAlpha * (1 - t) };
}

export function washRests(state: WashState, input: WashInput): boolean {
  "worklet";
  if (state.phase === "idle") return !input.loading;
  if (state.phase !== "showing" || !input.loading || state.alpha < 1) return false;
  const settled = LOAD_WASH.settleShare;
  return washCeiling(input) - state.creep < settled && Math.abs(state.creep - state.fill) < settled && Math.abs(state.velocity) < settled;
}
