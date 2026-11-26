export type WheelPhase = "none" | "mayBegin" | "began" | "changed" | "ended" | "cancelled";

export type WheelInput = {
  dy: number;
  phase?: WheelPhase;
  momentum?: boolean;
  precise?: boolean;
};

export type WheelRange = {
  lo: number;
  hi: number;
  forward: boolean;
  back: boolean;
};

export type WheelAction =
  | { kind: "none" }
  | { kind: "place"; y: number }
  | { kind: "ease"; y: number }
  | { kind: "move"; direction: 1 | -1 }
  | { kind: "settle" };

export type WheelTuning = {
  commit: number;
  follow: number;
  followMax: number;
  gestureGapMs: number;
  line: number;
  notchPendingMs: number;
  glideHoldShare: number;
  notchEaseMs: number;
  edgeRestMs: number;
};

export const STANDARD_WHEEL_TUNING: WheelTuning = {
  commit: 28,
  follow: 0.4,
  followMax: 26,
  gestureGapMs: 220,
  line: 40,
  notchPendingMs: 360,
  glideHoldShare: 0.7,
  notchEaseMs: 200,
  edgeRestMs: 300,
};

export const clampWheelRange = (range: WheelRange, y: number) => Math.min(range.hi, Math.max(range.lo, y));
const allowsRange = (range: WheelRange, by: number) => (by > 0 ? range.forward : range.back);

export class WheelSteer {
  readonly tune: WheelTuning;
  private accum = 0;
  private committed = false;
  private scrolledInside = false;
  private lastAt = -Infinity;
  private insideAt = -Infinity;
  private holdUntil = -Infinity;
  private pendingSince = -Infinity;

  constructor(tune: WheelTuning = STANDARD_WHEEL_TUNING) {
    this.tune = tune;
  }

  glideStarted(ms: number, now: number) {
    if (now - this.pendingSince >= this.tune.notchPendingMs) return;
    this.holdUntil = Math.max(this.holdUntil, now + ms * this.tune.glideHoldShare);
    this.pendingSince = -Infinity;
  }

  read(input: WheelInput, at: number, range: WheelRange, now: number): WheelAction {
    const phase = input.phase ?? "none";
    const momentum = input.momentum ?? false;
    const precise = input.precise ?? true;
    const ending = phase === "ended" || phase === "cancelled";
    const starting = precise && !momentum && (phase === "began" || phase === "mayBegin");
    if (starting) this.restart();
    if (!Number.isFinite(input.dy) || (input.dy === 0 && !ending)) return { kind: "none" };
    return precise ? this.swipe(input.dy, phase, momentum, ending, starting, at, range, now) : this.notch(input.dy, at, range, now);
  }

  private restart() {
    this.accum = 0;
    this.committed = false;
    this.scrolledInside = false;
  }

  private inside(by: number, at: number, range: WheelRange): number | null {
    if (range.hi <= range.lo) return null;
    const within = clampWheelRange(range, at);
    const atEdge = by > 0 ? within >= range.hi - 0.01 : within <= range.lo + 0.01;
    return atEdge ? null : clampWheelRange(range, within + by);
  }

  private notch(dy: number, at: number, range: WheelRange, now: number): WheelAction {
    const by = -dy * this.tune.line;
    if (now < this.holdUntil) return { kind: "none" };
    const next = this.inside(by, at, range);
    if (next !== null) {
      this.insideAt = now;
      return { kind: "ease", y: next };
    }
    if (now - this.insideAt < this.tune.edgeRestMs || !allowsRange(range, by)) return { kind: "none" };
    return this.commit(by, now);
  }

  private commit(by: number, now: number): WheelAction {
    this.holdUntil = now + this.tune.notchPendingMs;
    this.pendingSince = now;
    return { kind: "move", direction: by > 0 ? 1 : -1 };
  }

  private swipe(dy: number, phase: WheelPhase, momentum: boolean, ending: boolean, starting: boolean, at: number, range: WheelRange, now: number): WheelAction {
    const by = -dy;
    if (momentum) {
      if (this.committed) return { kind: "none" };
      const next = this.inside(by, at, range);
      return next === null ? { kind: "none" } : { kind: "place", y: next };
    }
    if (ending) return this.committed || this.scrolledInside ? { kind: "none" } : { kind: "settle" };
    const phaseless = phase === "none";
    const paused = phaseless && now - this.lastAt > this.tune.gestureGapMs;
    const spent = phaseless && this.committed && now >= this.holdUntil;
    const rested = phaseless && this.scrolledInside && now - this.insideAt >= this.tune.edgeRestMs;
    if (!starting && (paused || spent || rested)) this.restart();
    this.lastAt = now;
    if (this.committed) return { kind: "none" };
    const next = this.inside(by, at, range);
    if (next !== null) {
      this.scrolledInside = true;
      this.insideAt = now;
      return { kind: "place", y: next };
    }
    if (this.scrolledInside) return { kind: "none" };
    if (now < this.holdUntil) return { kind: "none" };
    if (!allowsRange(range, this.accum + by)) {
      const pulled = this.accum;
      this.accum = 0;
      return pulled === 0 ? { kind: "none" } : { kind: "place", y: pulled > 0 ? range.hi : range.lo };
    }
    this.accum += by;
    if (Math.abs(this.accum) >= this.tune.commit) {
      this.committed = true;
      return this.commit(this.accum, now);
    }
    const pull = Math.max(-this.tune.followMax, Math.min(this.tune.followMax, this.accum * this.tune.follow));
    return { kind: "place", y: (this.accum > 0 ? range.hi : range.lo) + pull };
  }
}
