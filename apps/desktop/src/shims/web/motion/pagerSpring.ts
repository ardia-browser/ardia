export const TRACKING_SCALE = 0.5;
export const RUBBER_DIMENSION = 255;
export const RUBBER_COEFFICIENT = 0.15;
export const FLICK_VELOCITY = 5;
export const SETTLE_PERIOD = 0.25;
export const OMEGA = (2 * Math.PI) / SETTLE_PERIOD;
export const REST_DISPLACEMENT = 0.003;
export const REST_SPEED = 0.1;
export const HISTORY_WINDOW = 0.1;
export const HISTORY_CAPACITY = 64;
export const MIN_PAGE_WIDTH = 1;
export const MAX_RELEASE_VELOCITY = 40;
export const MAX_SETTLE_SECONDS = 2;
export const FIRST_FRAME_LEAD = 1 / 60;
export const REVERSE_NUDGE = 0.07;
export const MID_TRANSITION = 0.1;

export type PagerInput = "prepare" | "abandon" | "began" | "changed" | "ended" | "cancelled";
export type PagerPhase = "idle" | "tracking" | "holding" | "settling";

export const PAGER_INPUTS: readonly PagerInput[] = ["prepare", "abandon", "began", "changed", "ended", "cancelled"];
export const PAGER_PHASES: readonly PagerPhase[] = ["idle", "tracking", "holding", "settling"];

export type PagerFrame = {
  position: number;
  velocity: number;
  phase: PagerPhase;
  selected: number;
  count: number;
  sequence: number;
  selectionSequence: number;
  moved: boolean;
  began: boolean;
  selectedChanged: boolean;
  settled: boolean;
  detentCrossed: boolean;
  needsFrame: boolean;
};

export function rubberBand(value: number, dimension: number) {
  if (!(value > 0)) return 0;
  if (value === Infinity) return dimension;
  return (1 - 1 / ((value * RUBBER_COEFFICIENT) / dimension + 1)) * dimension;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
const clampToIndex = (value: number, lo: number, hi: number) => (Number.isNaN(value) ? lo : Math.trunc(clamp(value, lo, hi)));
const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export type MirroredFrame = Pick<PagerFrame, "position" | "velocity" | "phase" | "selected" | "count" | "began" | "selectedChanged" | "settled" | "detentCrossed">;

export type SequenceSource = { next: () => number; atLeast: (value: number) => void };

export function sequenceSource(start = 0): SequenceSource {
  let last = start;
  return {
    next: () => ++last,
    atLeast: (value) => {
      if (Number.isFinite(value)) last = Math.max(last, Math.trunc(value));
    },
  };
}

type Drag = { start: number; width: number; lo: number; hi: number; home: number; detent: number; interrupted: boolean };
type Sample = { time: number; position: number };
type Spring = { from: number; target: number; velocity: number; start: number | null };

export class PagerSpring {
  private readonly sequences: SequenceSource;

  constructor(sequences: SequenceSource = sequenceSource()) {
    this.sequences = sequences;
  }

  private configuredFlag = false;
  private reduceMotionFlag = false;
  private countValue = 1;
  private order: readonly string[] | null = null;
  private selectedValue = 0;
  private positionValue = 0;
  private velocityValue = 0;
  private phaseValue: PagerPhase = "idle";
  private sequenceValue = 0;
  private selectionSequenceValue = 0;
  private propSelected = 0;
  private propAck = 0;
  private drag: Drag = { start: 0, width: 0, lo: 0, hi: 0, home: 0, detent: 0, interrupted: false };
  private history: Sample[] = [];
  private spring: Spring | null = null;
  private lastFrame: number | null = null;
  private movedFlag = false;
  private beganFlag = false;
  private selectedChangedFlag = false;
  private settledFlag = false;
  private detentCrossedFlag = false;

  configure(count: number, selected: number, ack: number, order: readonly string[] | null = null): boolean {
    const clamped = Math.max(1, Math.trunc(count) || 1);
    const current = !this.configuredFlag || ack >= this.selectionSequenceValue;
    this.propSelected = clamp(current ? Math.trunc(selected) || 0 : this.selectedValue, 0, clamped - 1);
    this.propAck = Math.max(this.propAck, ack);
    this.sequences.atLeast(this.propAck);
    if (!this.configuredFlag) {
      this.configuredFlag = true;
      this.countValue = clamped;
      this.order = order;
      this.selectedValue = this.propSelected;
      this.positionValue = this.selectedValue;
      this.sequenceValue = this.next();
      this.movedFlag = true;
      return false;
    }
    const reordered = !!order && (!this.order || !sameOrder(order, this.order));
    if (clamped !== this.countValue || reordered) {
      let index = this.propSelected;
      const old = this.order;
      this.countValue = clamped;
      this.order = order;
      if (this.propAck < this.selectionSequenceValue && old && order && this.selectedValue >= 0 && this.selectedValue < old.length) {
        const moved = order.indexOf(old[this.selectedValue]!);
        if (moved >= 0) index = moved;
      }
      this.cancelMotion();
      this.jump(clamp(index, 0, this.countValue - 1));
      return true;
    }
    this.reconcile();
    return false;
  }

  input(input: PagerInput, distance: number, direction: number, pageWidth: number, timestamp: number) {
    if (!this.configuredFlag) return;
    switch (input) {
      case "prepare":
        if (this.phaseValue === "settling") {
          this.spring = null;
          this.phaseValue = "holding";
          this.velocityValue = 0;
        }
        return;
      case "abandon":
        if (this.phaseValue === "holding") this.settle(this.selectedValue, 0);
        else if (this.phaseValue === "tracking") this.release(0, false);
        return;
      case "began":
        this.begin();
        this.track(distance, direction, pageWidth, timestamp, true);
        return;
      case "changed":
        if (this.phaseValue !== "tracking") return;
        this.track(distance, direction, pageWidth, timestamp, true);
        return;
      case "ended":
      case "cancelled":
        if (this.phaseValue !== "tracking") return;
        this.track(distance, direction, pageWidth, timestamp, false);
        this.release(this.releaseVelocity(timestamp), input === "cancelled");
    }
  }

  stepFrame(timestamp: number): PagerFrame {
    if (!Number.isFinite(timestamp)) return this.drain();
    const now = this.lastFrame !== null ? Math.max(timestamp, this.lastFrame) : timestamp;
    const previous = this.lastFrame ?? now;
    this.lastFrame = now;
    if (this.phaseValue === "settling" && this.spring) {
      if (this.spring.start === null) this.spring.start = now - clamp(now - previous, 0, FIRST_FRAME_LEAD);
      this.advanceSpring(now - this.spring.start);
    }
    return this.drain();
  }

  drain(): PagerFrame {
    const frame = this.snapshot();
    this.movedFlag = false;
    this.beganFlag = false;
    this.selectedChangedFlag = false;
    this.settledFlag = false;
    this.detentCrossedFlag = false;
    return frame;
  }

  snapshot(): PagerFrame {
    return {
      position: this.positionValue,
      velocity: this.velocityValue,
      phase: this.phaseValue,
      selected: this.selectedValue,
      count: this.countValue,
      sequence: this.sequenceValue,
      selectionSequence: this.selectionSequenceValue,
      moved: this.movedFlag,
      began: this.beganFlag,
      selectedChanged: this.selectedChangedFlag,
      settled: this.settledFlag,
      detentCrossed: this.detentCrossedFlag,
      needsFrame: this.phaseValue === "settling",
    };
  }

  switchTo(index: number, order?: readonly string[]) {
    if (!this.configuredFlag) return false;
    this.sync(order);
    const target = clamp(Math.trunc(index) || 0, 0, this.countValue - 1);
    const v = this.phaseValue === "settling" ? this.velocityValue : 0;
    this.settle(target, this.towards(target, v));
    return true;
  }

  step(delta: number, wrap: boolean, order?: readonly string[]) {
    if (!this.configuredFlag) return false;
    this.sync(order);
    const count = this.countValue;
    const moved = this.selectedValue + delta;
    const target = wrap ? ((moved % count) + count) % count : clamp(moved, 0, count - 1);
    return target === this.selectedValue || this.switchTo(target);
  }

  select(id: string, order: readonly string[]) {
    if (!this.configuredFlag) return false;
    const found = order.indexOf(id);
    if (found < 0) return false;
    this.cancelMotion();
    this.countValue = order.length;
    this.order = order;
    this.jump(found, true);
    this.selectedChangedFlag = true;
    return true;
  }

  setReduceMotion(reduce: boolean) {
    this.reduceMotionFlag = reduce;
    if (reduce && this.phaseValue === "settling" && this.spring) this.rest(this.spring.target);
  }

  mirror(frame: MirroredFrame) {
    if (!this.configuredFlag || frame.count !== this.countValue) return false;
    if (![frame.position, frame.velocity].every(Number.isFinite)) return false;
    const selected = clampToIndex(frame.selected, 0, this.countValue - 1);
    this.spring = null;
    if (frame.began) {
      this.sequenceValue = this.next();
      this.beganFlag = true;
      this.history = [];
    }
    if (selected !== this.selectedValue) {
      this.selectedValue = selected;
      this.sequenceValue = this.next();
      this.selectionSequenceValue = this.sequenceValue;
      this.selectedChangedFlag = true;
    }
    if (frame.detentCrossed) this.detentCrossedFlag = true;
    if (frame.phase === "idle") {
      if (this.phaseValue !== "idle" || frame.settled) this.rest(selected);
      else if (this.positionValue !== selected || this.velocityValue !== 0) {
        this.positionValue = selected;
        this.velocityValue = 0;
        this.movedFlag = true;
      }
      return true;
    }
    this.phaseValue = frame.phase;
    this.positionValue = frame.position;
    this.velocityValue = frame.velocity;
    this.movedFlag = true;
    return true;
  }

  takeOver() {
    if (this.phaseValue === "idle" || this.spring) return;
    const target = this.selectedValue;
    this.settle(target, this.phaseValue === "holding" ? 0 : this.towards(target, this.velocityValue));
  }

  get configured() {
    return this.configuredFlag;
  }
  get reduceMotion() {
    return this.reduceMotionFlag;
  }
  get phase() {
    return this.phaseValue;
  }
  get position() {
    return this.positionValue;
  }
  get velocity() {
    return this.velocityValue;
  }
  get selected() {
    return this.selectedValue;
  }
  get count() {
    return this.countValue;
  }
  get sequence() {
    return this.sequenceValue;
  }
  get selectionSequence() {
    return this.selectionSequenceValue;
  }
  get historySize() {
    return this.history.length;
  }
  get ack() {
    return this.propAck;
  }
  get pendingSelection() {
    return this.propSelected;
  }

  selectedId(): string | null {
    const order = this.order;
    return order && this.selectedValue >= 0 && this.selectedValue < order.length ? order[this.selectedValue]! : null;
  }

  hasOrder() {
    return this.order !== null;
  }

  orderIndex(id: string) {
    return this.order ? this.order.indexOf(id) : -1;
  }

  private next() {
    return this.sequences.next();
  }

  private reconcile() {
    if (this.phaseValue !== "idle" || this.propAck < this.selectionSequenceValue || this.propSelected === this.selectedValue) return;
    this.jump(clamp(this.propSelected, 0, this.countValue - 1));
  }

  private jump(index: number, selection = false) {
    this.selectedValue = index;
    this.positionValue = index;
    this.velocityValue = 0;
    this.sequenceValue = this.next();
    if (selection) this.selectionSequenceValue = this.sequenceValue;
    this.movedFlag = true;
  }

  private begin() {
    this.spring = null;
    const home = this.selectedValue;
    const x = this.positionValue;
    const lo = Math.max(0, Math.min(home - 1, Math.floor(x)));
    const hi = Math.min(this.countValue - 1, Math.max(home + 1, Math.ceil(x)));
    const interrupted = (this.phaseValue === "settling" || this.phaseValue === "holding") && x !== home;
    this.drag = { start: x, width: 0, lo, hi, home, detent: clampToIndex(Math.round(x), lo, hi), interrupted };
    this.history = [];
    this.velocityValue = 0;
    this.phaseValue = "tracking";
    this.sequenceValue = this.next();
    this.beganFlag = true;
  }

  private track(distance: number, direction: number, pageWidth: number, timestamp: number, sample: boolean) {
    if (Number.isFinite(pageWidth) && pageWidth >= MIN_PAGE_WIDTH) this.drag.width = pageWidth;
    const width = this.drag.width;
    if (!(width >= MIN_PAGE_WIDTH) || !Number.isFinite(distance)) return;
    const raw = this.drag.start + (direction > 0 ? -1 : 1) * ((distance * TRACKING_SCALE) / width);
    const { lo, hi } = this.drag;
    let x = raw;
    if (raw > hi) x = hi + rubberBand((raw - hi) * width, RUBBER_DIMENSION) / width;
    else if (raw < lo) x = lo - rubberBand((lo - raw) * width, RUBBER_DIMENSION) / width;
    if (!Number.isFinite(x)) return;
    this.positionValue = x;
    this.movedFlag = true;
    if (sample && Number.isFinite(timestamp)) this.record(timestamp, x);
    const nearest = clampToIndex(Math.round(x), lo, hi);
    if (nearest !== this.drag.detent) {
      this.drag.detent = nearest;
      this.detentCrossedFlag = true;
    }
  }

  private record(timestamp: number, x: number) {
    const last = this.history.at(-1);
    const time = last ? Math.max(timestamp, last.time) : timestamp;
    if (this.history.length === HISTORY_CAPACITY) this.history.shift();
    this.history.push({ time, position: x });
    while (this.history.length && time - this.history[0]!.time > HISTORY_WINDOW) this.history.shift();
  }

  private releaseVelocity(timestamp: number) {
    const last = this.history.at(-1);
    if (!last) return 0;
    const now = Number.isFinite(timestamp) ? Math.max(timestamp, last.time) : last.time;
    const recent = this.history.filter((sample) => now - sample.time <= HISTORY_WINDOW);
    const first = recent[0];
    const final = recent.at(-1);
    if (recent.length < 2 || !first || !final || !(final.time > first.time)) return 0;
    const v = (final.position - first.position) / (final.time - first.time);
    if (!Number.isFinite(v)) return 0;
    return clamp(v, -MAX_RELEASE_VELOCITY, MAX_RELEASE_VELOCITY);
  }

  private release(v: number, cancelled: boolean) {
    const home = this.drag.home;
    let target = home;
    if (!cancelled) {
      const flick = Math.abs(v * this.drag.width) >= FLICK_VELOCITY;
      const x = this.positionValue;
      const from = Math.abs(x - home) <= MID_TRANSITION ? home : x;
      const aim = flick ? (v > 0 ? Math.floor(from) + 1 : Math.ceil(from) - 1) : this.slowAim(x, home);
      const lo = Math.max(0, home - 1);
      const hi = Math.max(lo, Math.min(this.countValue - 1, home + 1));
      target = clampToIndex(aim, lo, hi);
      if (target !== home && this.reverseNudge(x, home, target)) target = home;
    }
    this.settle(target, this.towards(target, v));
  }

  private reverseNudge(x: number, home: number, target: number) {
    const from = this.drag.start - home;
    if (!this.drag.interrupted || Math.abs(from) <= MID_TRANSITION) return false;
    const reversing = (target - home > 0) === (from > 0);
    return reversing && Math.abs(x - this.drag.start) < REVERSE_NUDGE;
  }

  private slowAim(x: number, home: number) {
    const fromHome = x - home;
    const travelled = x - this.drag.start;
    const leftHome = Math.abs(fromHome) >= 0.5 && travelled !== 0 && fromHome > 0 === travelled > 0;
    return leftHome ? Math.round(x) : home;
  }

  private towards(target: number, v: number) {
    const d = target - this.positionValue;
    return d !== 0 && v !== 0 && d > 0 === v > 0 ? v : 0;
  }

  private sync(order?: readonly string[]) {
    if (!order || !order.length || (this.order && sameOrder(order, this.order))) return;
    const current = this.selectedId();
    const kept = current !== null && order.includes(current);
    const fallback = Math.min(Math.max(this.propSelected, 0), order.length - 1);
    this.select(kept ? current : order[fallback]!, order);
  }

  private settle(target: number, v: number) {
    if (target !== this.selectedValue) {
      this.selectedValue = target;
      this.sequenceValue = this.next();
      this.selectionSequenceValue = this.sequenceValue;
      this.selectedChangedFlag = true;
    }
    this.spring = null;
    if (this.reduceMotionFlag) {
      this.rest(target);
      return;
    }
    const bounded = overshootFreeVelocity(this.positionValue - target, v);
    this.phaseValue = "settling";
    this.velocityValue = bounded;
    this.spring = { from: this.positionValue, target, velocity: bounded, start: null };
  }

  private advanceSpring(t: number) {
    const s = this.spring!;
    const x0 = s.from - s.target;
    const b = s.velocity + OMEGA * x0;
    const decay = Math.exp(-OMEGA * t);
    const x = (x0 + b * t) * decay;
    const v = (s.velocity - OMEGA * b * t) * decay;
    if ((Math.abs(x) < REST_DISPLACEMENT && Math.abs(v) < REST_SPEED) || t >= MAX_SETTLE_SECONDS || !Number.isFinite(x) || !Number.isFinite(v)) {
      this.rest(s.target);
      return;
    }
    this.positionValue = s.target + x;
    this.velocityValue = v;
    this.movedFlag = true;
  }

  private rest(target: number) {
    this.spring = null;
    this.positionValue = target;
    this.velocityValue = 0;
    this.phaseValue = "idle";
    this.sequenceValue = this.next();
    this.movedFlag = true;
    this.settledFlag = true;
    this.reconcile();
  }

  private cancelMotion() {
    this.spring = null;
    this.phaseValue = "idle";
    this.velocityValue = 0;
  }
}

export function overshootFreeVelocity(displacement: number, velocity: number) {
  if (!(velocity * displacement < 0) || !Number.isFinite(velocity * displacement)) return 0;
  const bound = OMEGA * Math.abs(displacement);
  return Math.sign(velocity) * Math.min(Math.abs(velocity), bound);
}

export function springDisplacement(from: number, velocity: number, t: number) {
  const b = velocity + OMEGA * from;
  return (from + b * t) * Math.exp(-OMEGA * t);
}
