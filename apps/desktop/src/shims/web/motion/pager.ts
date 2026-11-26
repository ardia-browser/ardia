import type { NativePagerConfig, PagerSnapshot, PagerStateEvent } from "@ardia-real/ardiacore";
import { PagerSpring, sequenceSource, type MirroredFrame, type PagerFrame, type PagerInput } from "./pagerSpring";

export type { PagerInput } from "./pagerSpring";

export type NativePagerFrame = MirroredFrame & { frame: number; sequence: number; selectionSequence: number; profileId?: string | null };

export type PagerArea = {
  pageWidth: () => number;
  attached: () => boolean;
  onPosition: (position: number) => void;
  onState: (event: PagerStateEvent) => void;
};

export type PagerClock = {
  now: () => number;
  request: (step: (timestampMs: number) => void) => number;
  cancel: (id: number) => void;
  reduceMotion: () => boolean;
  watchReduceMotion: (listener: () => void) => () => void;
};

const FRAME_INTERVAL = 1 / 60;
const LONG_FRAME = FRAME_INTERVAL * 1.5;
export const NATIVE_FRAME_TIMEOUT = 0.25;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const reducedMotionQuery = () => (typeof matchMedia === "function" ? matchMedia(REDUCED_MOTION) : null);

export const browserClock: PagerClock = {
  now: () => performance.now() / 1000,
  request: (step) => requestAnimationFrame(step),
  cancel: (id) => cancelAnimationFrame(id),
  reduceMotion: () => !!reducedMotionQuery()?.matches,
  watchReduceMotion: (listener) => {
    const query = reducedMotionQuery();
    query?.addEventListener?.("change", listener);
    return () => query?.removeEventListener?.("change", listener);
  },
};

let clock: PagerClock = browserClock;

export function setPagerClock(next: PagerClock) {
  const was = clock;
  clock = next;
  return () => void (clock = was);
}

let motions = 0;
export const PAGER_MOVING_MARK = "ardia-pager-moving";
export const PAGER_REST_MARK = "ardia-pager-rest";
export const PAGER_MARKS_KEPT = 16;

const mark = (name: string) => {
  const timing = globalThis.performance;
  if (typeof timing?.mark !== "function") return;
  if (typeof timing.getEntriesByName === "function" && typeof timing.clearMarks === "function" && timing.getEntriesByName(name, "mark").length >= PAGER_MARKS_KEPT) timing.clearMarks(name);
  timing.mark(name);
};

const sequences = sequenceSource();
const pagers = new Map<string, Pager>();

type SettleStats = { last: number | null; frames: number; long: number; worst: number };

export class Pager {
  private areas = new Set<PagerArea>();
  private dragArea: PagerArea | null = null;
  private readonly spring = new PagerSpring(sequences);
  private frameId = 0;
  private motion = 0;
  private stats: SettleStats | null = null;
  private owner: "js" | "native" = "js";
  private nativeFrameSeen = 0;
  private nativeSelection = 0;
  private revokedSelection: number | null = null;
  private nativeAt = 0;
  private nativeWatch: ReturnType<typeof setTimeout> | undefined;
  private stopReduceMotion: () => void;
  private moving = false;

  static named(key: string) {
    let pager = pagers.get(key);
    if (!pager) pagers.set(key, (pager = new Pager(key)));
    return pager;
  }

  static existing(key: string) {
    return pagers.get(key);
  }

  readonly key: string;

  private constructor(key: string) {
    this.key = key;
    this.spring.setReduceMotion(clock.reduceMotion());
    this.stopReduceMotion = clock.watchReduceMotion(() => {
      const reduce = clock.reduceMotion();
      this.spring.setReduceMotion(reduce);
      if (reduce) this.revokeNative();
      this.flush();
    });
  }

  attach(area: PagerArea) {
    this.areas.add(area);
    if (this.spring.configured) area.onPosition(this.spring.position);
  }

  detach(area: PagerArea) {
    this.areas.delete(area);
    if (this.dragArea === area) this.dragArea = null;
    if (this.areas.size || pagers.get(this.key) !== this) return;
    this.stopFrames();
    this.stopNativeWatch();
    this.stopReduceMotion();
    this.stopMoving();
    pagers.delete(this.key);
  }

  configure({ selected, count, ack, order }: NativePagerConfig) {
    const first = !this.spring.configured;
    const remapped = this.spring.configure(count, selected, ack ?? 0, order ?? null);
    if (remapped && this.owner === "native") {
      this.releaseNative();
      this.revokedSelection = this.nativeSelection;
    } else if (this.spring.phase === "idle") this.releaseNative();
    this.flush(first ? { quiet: true } : undefined);
  }

  input(area: PagerArea, input: PagerInput, distance: number, direction: number, timestamp: number) {
    if (!this.spring.configured) return;
    if (input === "abandon" && this.spring.phase === "tracking" && this.dragArea !== area) return;
    if ((input === "changed" || input === "ended" || input === "cancelled") && this.dragArea !== area) return;
    this.revokeNative();
    if (input === "began") this.dragArea = area;
    const width = (this.dragArea ?? area).pageWidth();
    this.spring.input(input, distance, direction, width, timestamp);
    if (this.spring.phase !== "tracking") this.dragArea = null;
    this.flush();
  }

  switchTo(index: number, order?: readonly string[]) {
    this.revokeNative();
    this.dragArea = null;
    const ok = this.spring.switchTo(index, order);
    this.flush();
    return ok;
  }

  step(delta: number, wrap: boolean, order?: readonly string[]) {
    this.revokeNative();
    const ok = this.spring.step(delta, wrap, order);
    if (this.spring.phase !== "tracking") this.dragArea = null;
    this.flush();
    return ok;
  }

  select(profileId: string, order: readonly string[]) {
    if (!this.spring.configured || !order.includes(profileId)) return false;
    this.revokeNative();
    if (!this.spring.select(profileId, order)) return false;
    this.dragArea = null;
    this.stopFrames();
    this.flush({ outOfMotion: true });
    return true;
  }

  applyNativeFrame(native: NativePagerFrame) {
    if (!this.spring.configured || native.frame <= this.nativeFrameSeen) return false;
    if (this.dragArea !== null && this.spring.phase === "tracking") return false;
    if (native.count !== this.spring.count || !Number.isFinite(native.position) || !Number.isFinite(native.velocity)) return false;
    if (native.profileId !== undefined && native.profileId !== null) {
      const index = this.spring.orderIndex(native.profileId);
      if (index < 0) return false;
      if (index !== native.selected) {
        if (this.owner === "native") {
          this.nativeSelection = Math.max(this.nativeSelection, native.selectionSequence);
          this.revokeNative();
          this.flush();
        }
        return false;
      }
    }
    if (this.revokedSelection !== null) {
      if (!native.began) return false;
      this.revokedSelection = null;
    }
    if (!this.spring.mirror(native)) return false;
    this.nativeFrameSeen = native.frame;
    this.nativeSelection = Math.max(this.nativeSelection, native.selectionSequence);
    this.dragArea = null;
    this.stopFrames();
    this.sampleNative(native.phase, native.settled);
    if (native.phase === "settling" && this.spring.reduceMotion) {
      this.owner = "native";
      this.revokeNative();
    } else if (native.phase === "idle") this.releaseNative();
    else {
      this.owner = "native";
      this.nativeAt = clock.now();
      this.armNativeWatch();
    }
    this.flush();
    return true;
  }

  private sampleNative(phase: NativePagerFrame["phase"], settled: boolean) {
    if (settled && this.stats && this.stats.last !== null) {
      this.sampleGap(this.stats, clock.now());
      return;
    }
    if (phase !== "settling") {
      if (this.stats) this.stats.last = null;
      return;
    }
    this.stats ??= { last: null, frames: 0, long: 0, worst: 0 };
    this.sampleGap(this.stats, clock.now());
  }

  private sampleGap(stats: SettleStats, now: number) {
    if (stats.last === null) {
      stats.last = now;
      return;
    }
    const gap = now - stats.last;
    if (!(gap > 0)) return;
    stats.worst = Math.max(stats.worst, gap);
    if (gap > LONG_FRAME) stats.long++;
    stats.frames++;
    stats.last = now;
  }

  get drivenNatively() {
    return this.owner === "native";
  }

  private armNativeWatch() {
    if (this.nativeWatch) return;
    const check = () => {
      this.nativeWatch = undefined;
      if (this.owner !== "native") return;
      const quiet = clock.now() - this.nativeAt;
      if (quiet < NATIVE_FRAME_TIMEOUT) {
        this.nativeWatch = setTimeout(check, (NATIVE_FRAME_TIMEOUT - quiet) * 1000);
        return;
      }
      this.revokeNative();
      this.flush();
    };
    this.nativeWatch = setTimeout(check, NATIVE_FRAME_TIMEOUT * 1000);
  }

  private stopNativeWatch() {
    clearTimeout(this.nativeWatch);
    this.nativeWatch = undefined;
  }

  private releaseNative() {
    this.owner = "js";
    this.stopNativeWatch();
  }

  private revokeNative() {
    if (this.owner !== "native") return;
    this.releaseNative();
    this.revokedSelection = this.nativeSelection;
    this.spring.takeOver();
  }

  private flush(options: { quiet?: boolean; outOfMotion?: boolean } = {}) {
    const wasIdle = this.motion === 0;
    const frame = this.spring.drain();
    if (frame.phase !== "settling" || this.owner !== "js") this.stopFrames();
    if ((frame.phase === "holding" || frame.phase === "tracking") && this.stats) this.stats.last = null;
    if (!options.outOfMotion && wasIdle && frame.phase !== "idle") {
      this.motion = ++motions;
      this.startMoving();
    }
    this.emit(frame, options);
    if (frame.phase === "settling" && this.owner === "js") {
      if (!this.stats) this.stats = { last: clock.now(), frames: 0, long: 0, worst: 0 };
      else if (!this.frameId) this.stats.last = clock.now();
      this.startFrames();
    }
  }

  private emit(frame: PagerFrame, { quiet, outOfMotion }: { quiet?: boolean; outOfMotion?: boolean }) {
    if (quiet) {
      if (frame.moved) this.emitPosition(frame.position);
      return;
    }
    const motion = outOfMotion ? undefined : this.motion || undefined;
    if (frame.began) this.emitState("began", frame, motion);
    if (frame.selectedChanged) this.emitState("selected", frame, motion);
    if (frame.moved) this.emitPosition(frame.position);
    if (frame.settled) {
      const stats = this.stats;
      this.stats = null;
      this.emitState("settled", frame, motion, stats ? { frames: stats.frames, longFrames: stats.long, worstGapMs: Math.round(stats.worst * 1000) } : undefined);
    }
    if (frame.phase === "idle") {
      this.motion = 0;
      this.stats = null;
      this.stopMoving();
    }
  }

  private startMoving() {
    if (this.moving) return;
    this.moving = true;
    mark(PAGER_MOVING_MARK);
  }

  private stopMoving() {
    if (!this.moving) return;
    this.moving = false;
    mark(PAGER_REST_MARK);
  }

  private startFrames() {
    if (this.frameId) return;
    const step = (timestampMs: number) => {
      this.frameId = 0;
      if (this.owner !== "js" || this.spring.phase !== "settling") return;
      const now = Number.isFinite(timestampMs) ? timestampMs / 1000 : clock.now();
      if (this.stats) this.sampleGap(this.stats, now);
      this.emit(this.spring.stepFrame(now), {});
      if (this.spring.phase === "settling") this.frameId = clock.request(step);
    };
    this.frameId = clock.request(step);
  }

  private stopFrames() {
    if (this.frameId) clock.cancel(this.frameId);
    this.frameId = 0;
  }

  private emitPosition(position: number) {
    const tracking = this.spring.phase === "tracking" ? this.dragArea : null;
    const all = [...this.areas];
    (tracking ?? all.find((a) => a.attached()) ?? all[0])?.onPosition(position);
  }

  private emitState(phase: PagerStateEvent["phase"], frame: PagerFrame, motion: number | undefined, extra?: Partial<PagerStateEvent>) {
    const event: PagerStateEvent = { phase, sequence: frame.sequence, position: frame.position, selected: frame.selected, velocity: frame.velocity };
    if (motion !== undefined) event.motion = motion;
    if (extra) Object.assign(event, extra);
    if (this.spring.hasOrder()) event.profileId = this.spring.selectedId();
    for (const area of [...this.areas]) area.onState(event);
  }

  snapshot(): PagerSnapshot {
    const s = this.spring;
    const snapshot: PagerSnapshot = {
      sequence: s.sequence,
      selectionSequence: s.selectionSequence,
      position: s.position,
      selected: s.selected,
      phase: s.phase,
      velocity: s.velocity,
      count: s.count,
    };
    if (s.hasOrder()) snapshot.profileId = s.selectedId();
    return snapshot;
  }

  debug() {
    return { ...this.snapshot(), areas: this.areas.size, propSelected: this.spring.pendingSelection, propAck: this.spring.ack, history: this.spring.historySize, owner: this.owner, revokedSelection: this.revokedSelection, reduceMotion: this.spring.reduceMotion };
  }
}

if (import.meta.env?.DEV) (globalThis as { acLinuxPagers?: unknown }).acLinuxPagers = pagers;
