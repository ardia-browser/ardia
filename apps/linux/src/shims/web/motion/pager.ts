import type { PagerSnapshot, PagerStateEvent } from "@ardia-real/ardiacore";
import { statesLater, PagerMachine, type PagerClock } from "@ardia/ardiacore/src/pagerModel.ts";
import { clamp, FLICK_VELOCITY, HISTORY_WINDOW, releaseVelocity, RUBBER_DIMENSION, rubberBand, shiftDrag, TRACKING_SCALE } from "./pagerPhysics";

export { rubberBand };

export type PagerPhase = PagerSnapshot["phase"];
export type PagerInput = "prepare" | "abandon" | "began" | "changed" | "ended" | "cancelled";

export type PagerArea = {
  pageWidth: () => number;
  attached: () => boolean;
  onPosition: (position: number, leading: number) => void;
  onState: (event: PagerStateEvent) => void;
};

type Drag = { start: number; raw: number; lo: number; hi: number; home: number; detent: number; area: PagerArea | null };

const reduceMotionQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null);

export const browserClock: PagerClock = {
  now: () => performance.now() / 1000,
  requestFrame: (frame) => requestAnimationFrame((time) => frame(time / 1000)),
  cancelFrame: (id) => cancelAnimationFrame(id),
  reducedMotion: () => !!reduceMotionQuery()?.matches,
};

const pagers = new Map<string, Pager>();

export class Pager extends PagerMachine {
  private areas = new Set<PagerArea>();
  private drag: Drag = { start: 0, raw: 0, lo: 0, hi: 0, home: 0, detent: 0, area: null };
  private history: { time: number; position: number }[] = [];

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
    const relay: { pager?: Pager } = {};
    super(browserClock, {
      position: (position, lead) => relay.pager?.sendPosition(position, lead),
      state: statesLater(() => relay.pager?.areas ?? new Set<PagerArea>(), (area, event) => area.onState(event)),
    });
    relay.pager = this;
    this.key = key;
  }

  private sendPosition(position: number, lead: number) {
    const tracking = this.phase === "tracking" ? this.drag.area : null;
    const all = [...this.areas];
    (tracking ?? all.find((a) => a.attached()) ?? all[0])?.onPosition(position, lead);
  }

  attach(area: PagerArea) {
    this.areas.add(area);
    if (this.configured) area.onPosition(this.view.pagePosition, this.view.lead);
  }

  detach(area: PagerArea) {
    this.areas.delete(area);
    if (this.drag.area === area && !this.cancelTracking()) this.drag.area = null;
    if (this.areas.size || pagers.get(this.key) !== this) return;
    this.stop();
    pagers.delete(this.key);
  }

  input(area: PagerArea, input: PagerInput, distance: number, direction: number, timestamp: number) {
    switch (input) {
      case "prepare":
        return this.hold();
      case "abandon":
        if (this.phase === "holding") this.settle(this.selected, 0);
        else if (this.phase === "tracking" && this.drag.area === area) this.release(0, false);
        return;
      case "began":
        this.begin(area);
        this.track(distance, direction, timestamp, true);
        return;
      case "changed":
        if (this.phase !== "tracking" || this.drag.area !== area) return;
        this.track(distance, direction, timestamp, true);
        return;
      case "ended":
      case "cancelled":
        if (this.phase !== "tracking" || this.drag.area !== area) return;
        this.track(distance, direction, timestamp, false);
        this.release(releaseVelocity(this.history, timestamp), input === "cancelled");
    }
  }

  protected override endTracking() {
    this.drag.area = null;
  }

  protected override shifted(shift: number) {
    this.history = this.history.map((h) => ({ time: h.time, position: h.position + shift }));
    if (this.phase === "tracking") this.drag = shiftDrag(this.drag, shift, this.count);
  }

  private begin(area: PagerArea) {
    this.beginTracking(() => {
      const home = this.selected;
      const x = this.position;
      const lo = Math.max(this.view.floor, Math.min(home - 1, Math.floor(x)));
      const hi = Math.min(this.count - 1, Math.max(home + 1, Math.ceil(x)));
      this.drag = { start: x, raw: x, lo, hi, home, detent: clamp(Math.round(x), lo, hi), area };
      this.history = [];
    });
  }

  private track(distance: number, direction: number, timestamp: number, sample: boolean) {
    const area = this.drag.area;
    if (!area) return;
    const width = area.pageWidth();
    if (!(width > 0)) return;
    const raw = this.drag.start + (direction > 0 ? -1 : 1) * ((distance * TRACKING_SCALE) / width);
    this.drag.raw = raw;
    const { lo, hi } = this.drag;
    const x = raw > hi ? hi + rubberBand((raw - hi) * width, RUBBER_DIMENSION) / width : raw < lo ? lo - rubberBand((lo - raw) * width, RUBBER_DIMENSION) / width : raw;
    if (sample) {
      const time = Math.max(timestamp, this.history.at(-1)?.time ?? timestamp);
      this.history.push({ time, position: x });
      this.history = this.history.filter((h) => time - h.time <= HISTORY_WINDOW);
    }
    this.drag.detent = clamp(Math.round(x), lo, hi);
    this.trackTo(x);
  }

  private release(v: number, cancelled: boolean) {
    const { home, lo, hi } = this.drag;
    const width = this.drag.area?.pageWidth() ?? 0;
    this.drag.area = null;
    let target = home;
    if (!cancelled) {
      const flick = Math.abs(v * width) >= FLICK_VELOCITY;
      const aimed = !flick ? Math.round(this.position) : v > 0 ? Math.floor(this.position) + 1 : Math.ceil(this.position) - 1;
      target = clamp(Math.max(this.view.floor, home - 1, Math.min(this.count - 1, home + 1, aimed)), lo, hi);
    }
    this.settle(target, this.towards(target, v));
  }

  override debug() {
    return { ...super.debug(), areas: this.areas.size, history: this.history.length, drag: this.phase === "tracking" ? { ...this.drag, area: undefined } : undefined };
  }
}

if (import.meta.env?.DEV) (globalThis as { acLinuxPagers?: unknown }).acLinuxPagers = pagers;
