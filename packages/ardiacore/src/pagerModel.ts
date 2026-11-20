import type { NativePagerConfig, PagerSnapshot, PagerStateEvent } from "./swipe";
import { clampIndex, leadingView, sameOrder, springAt, stepAction, type LeadingView } from "./pagerMath.ts";

export * from "./pagerMath.ts";

export type PagerPhase = PagerSnapshot["phase"];

export type PagerClock = {
  now(): number;
  requestFrame(frame: (time: number) => void): number;
  cancelFrame(id: number): void;
  reducedMotion(): boolean;
  startMotion?(): () => void;
};

export type PagerEmitter = {
  position(pagePosition: number, lead: number): void;
  state(event: PagerStateEvent): void;
};

export type PagerConfig = Pick<NativePagerConfig, "selected" | "count" | "ack" | "order" | "leading" | "library">;

type Spring = { from: number; target: number; velocity: number; start: number };

let sequenceCounter = 0;
const nextSequence = () => ++sequenceCounter;

export function statesLater<Area>(areas: () => ReadonlySet<Area>, send: (area: Area, event: PagerStateEvent) => void): (event: PagerStateEvent) => void {
  return (event) => {
    const told = [...areas()];
    queueMicrotask(() => {
      const attached = areas();
      for (const area of told) if (attached.has(area)) send(area, event);
    });
  };
}

export class PagerMachine {
  protected readonly clock: PagerClock;
  private readonly emitter: PagerEmitter;
  protected configured = false;
  protected leading = false;
  protected anchor: number | null = null;
  protected count = 1;
  protected order: readonly string[] | null = null;
  protected selected = 0;
  protected position = 0;
  protected velocity = 0;
  protected phase: PagerPhase = "idle";
  private sequence = 0;
  private selectionSequence = 0;
  private propSelected = 0;
  private propAck = 0;
  private propLibrary = false;
  private spring: Spring | null = null;
  private frameId: number | null = null;
  private endMotion: (() => void) | null = null;
  private leadOnRest = false;

  constructor(clock: PagerClock, emitter: PagerEmitter) {
    this.clock = clock;
    this.emitter = emitter;
  }

  protected get view(): LeadingView {
    return leadingView(this.anchor, this.selected, this.position, this.leading);
  }

  configure({ selected, count: rawCount, ack, order, leading, library }: PagerConfig) {
    const count = Math.max(1, Math.trunc(rawCount));
    this.propSelected = clampIndex(Math.trunc(selected), count);
    this.propAck = Math.max(this.propAck, ack ?? 0);
    this.leading = !!leading;
    this.propLibrary = this.leading && !!library;
    const newOrder = order ?? null;
    if (!this.configured) {
      this.configured = true;
      this.count = count;
      this.order = newOrder;
      this.jump(this.propSelected, false, this.propLibrary ? this.propSelected : null);
      this.emitState("selected");
      return;
    }
    if (count !== this.count || (newOrder !== null && !sameOrder(newOrder, this.order))) {
      let index = this.propSelected;
      const old = this.order;
      const { home, atLeading } = this.view;
      this.count = count;
      this.order = newOrder;
      if (this.propAck < this.selectionSequence && old && home >= 0 && home < old.length) {
        const moved = newOrder?.indexOf(old[home]!) ?? -1;
        if (moved >= 0) index = moved;
      }
      const stayLeading = atLeading && this.leading;
      this.cancelMotion();
      this.place(index, stayLeading ? index : null);
      return this.reconcile();
    }
    if (!this.leading) this.leadOnRest = false;
    if (!this.leading && this.anchor !== null && this.phase !== "tracking") {
      const { atLeading, home } = this.view;
      if (atLeading) return this.settle(home, this.towards(home, this.coasting));
      if (this.phase === "idle") this.anchor = null;
    }
    this.reconcile();
  }

  switchTo(index: number, order?: readonly string[] | null): boolean {
    if (!this.configured) return false;
    this.sync(order);
    const target = clampIndex(Math.trunc(index), this.count);
    if (this.anchor !== null && target !== this.anchor && this.position < this.anchor) this.reanchor(target);
    this.endTracking();
    this.settle(target, this.towards(target, this.coasting));
    return true;
  }

  step(delta: number, wrap: boolean, order?: readonly string[] | null): boolean {
    if (!this.configured) return false;
    this.sync(order);
    const action = stepAction({ anchor: this.anchor, selected: this.selected, leading: this.leading, count: this.count }, Math.trunc(delta), wrap);
    return action.kind === "stay" || (action.kind === "lead" ? this.lead(true) : this.switchTo(action.index));
  }

  lead(open: boolean, animated = true): boolean {
    if (!this.configured || !(this.leading || !open)) return false;
    if (!open && !animated) {
      this.leadOnRest = false;
      if (this.anchor === null) return true;
      const target = this.view.home;
      this.cancelMotion();
      this.jump(target, true);
      this.emitState("selected");
      return true;
    }
    this.endTracking();
    const v = this.coasting;
    if (!open) {
      this.leadOnRest = false;
      if (this.anchor !== null) this.settle(this.anchor, this.towards(this.anchor, v));
      return true;
    }
    if (this.anchor === null) {
      if (this.position < this.selected) {
        this.settle(this.selected, this.towards(this.selected, v), true);
        return true;
      }
      this.anchor = this.selected;
    }
    const target = this.view.floor;
    this.settle(target, this.towards(target, v));
    return true;
  }

  select(profileId: string, ids: readonly string[]): boolean {
    if (!this.configured) return false;
    const index = ids.indexOf(profileId);
    if (index < 0) return false;
    if (this.anchor !== null && this.position < this.anchor) {
      this.count = ids.length;
      this.order = ids;
      this.reanchor(index);
      this.emitPosition();
      this.emitState("selected");
      return true;
    }
    this.cancelMotion();
    this.count = ids.length;
    this.order = ids;
    this.jump(index, true);
    this.emitState("selected");
    return true;
  }

  cancelTracking(): boolean {
    if (this.phase !== "tracking") return false;
    this.endTracking();
    this.settle(this.selected, 0);
    return true;
  }

  snapshot(): PagerSnapshot {
    const view = this.view;
    const snapshot: PagerSnapshot = {
      sequence: this.sequence,
      selectionSequence: this.selectionSequence,
      position: this.position,
      selected: view.atLeading ? -1 : view.home,
      phase: this.phase,
      velocity: this.velocity,
      count: this.count,
      leading: view.atLeading,
      lead: view.lead,
    };
    if (this.order) snapshot.profileId = this.selectedId();
    return snapshot;
  }

  debug() {
    const view = this.view;
    return {
      ...this.snapshot(),
      propSelected: this.propSelected,
      propAck: this.propAck,
      propLibrary: this.propLibrary,
      leadingOn: this.leading,
      anchor: this.anchor,
      pagePosition: view.pagePosition,
      home: view.home,
      leadOnRest: this.leadOnRest,
    };
  }

  stop() {
    this.stopSpring();
    this.leadOnRest = false;
  }

  protected endTracking() {}

  protected shifted(_shift: number) {}

  protected hold() {
    if (this.phase !== "settling") return;
    this.stopSpring();
    this.leadOnRest = false;
    this.phase = "holding";
  }

  protected beginTracking(measure: () => void) {
    this.stopSpring();
    this.leadOnRest = false;
    if (this.anchor === null && this.leading && this.selected === 0) this.anchor = 0;
    measure();
    this.velocity = 0;
    this.phase = "tracking";
    this.sequence = nextSequence();
    this.emitState("began");
  }

  protected trackTo(position: number) {
    this.position = position;
    this.emitPosition();
  }

  protected towards(target: number, v: number) {
    const d = target - this.position;
    return d !== 0 && v !== 0 && d > 0 === v > 0 ? v : 0;
  }

  protected settle(target: number, v: number, leadOnRest = false) {
    if (target !== this.selected) {
      this.selected = target;
      this.sequence = nextSequence();
      this.selectionSequence = this.sequence;
      this.emitState("selected");
    }
    this.stopSpring();
    this.leadOnRest = leadOnRest;
    if (this.clock.reducedMotion()) return this.rest(target);
    this.phase = "settling";
    this.velocity = v;
    const spring = { from: this.position, target, velocity: v, start: this.clock.now() };
    this.spring = spring;
    this.endMotion = this.clock.startMotion?.() ?? null;
    this.requestFrame(spring);
  }

  private get coasting() {
    return this.phase === "settling" ? this.velocity : 0;
  }

  private sync(order: readonly string[] | null | undefined) {
    if (!order?.length || sameOrder(order, this.order)) return;
    const { home } = this.view;
    const current = this.order && home >= 0 && home < this.order.length ? this.order[home] : undefined;
    const id = current !== undefined && order.includes(current) ? current : order[clampIndex(this.propSelected, order.length)]!;
    this.select(id, order);
  }

  private reconcile() {
    if (this.phase !== "idle" || this.propAck < this.selectionSequence) return;
    const { home, atLeading } = this.view;
    if (home !== this.propSelected) this.place(this.propSelected, this.propLibrary ? this.propSelected : null);
    else if (this.propLibrary !== atLeading) this.lead(this.propLibrary);
  }

  private place(index: number, anchor: number | null) {
    const wasLeading = this.view.atLeading;
    this.jump(index, false, anchor);
    if (this.view.atLeading !== wasLeading) this.emitState("selected");
  }

  private jump(index: number, selection = false, anchor: number | null = null) {
    this.anchor = anchor;
    const target = anchor === null ? index : anchor - 1;
    this.selected = target;
    this.position = target;
    this.velocity = 0;
    this.sequence = nextSequence();
    if (selection) this.selectionSequence = this.sequence;
    this.emitPosition();
  }

  private reanchor(index: number) {
    if (this.anchor === null) return;
    const shift = index - this.anchor;
    this.anchor = index;
    this.position += shift;
    this.selected += shift;
    if (this.spring) this.spring = { ...this.spring, from: this.spring.from + shift, target: this.spring.target + shift };
    this.shifted(shift);
    this.sequence = nextSequence();
    this.selectionSequence = this.sequence;
  }

  private requestFrame(spring: Spring) {
    this.frameId = this.clock.requestFrame((time) => {
      if (this.spring === null || this.spring.start !== spring.start) return;
      this.frameId = null;
      this.frame(time);
    });
  }

  private frame(time: number) {
    const spring = this.spring;
    if (!spring) return;
    const { offset, velocity, rested } = springAt(spring.from, spring.target, spring.velocity, Math.max(0, time - spring.start));
    if (rested) {
      this.stopSpring();
      return this.rest(spring.target);
    }
    this.position = spring.target + offset;
    this.velocity = velocity;
    this.emitPosition();
    this.requestFrame(spring);
  }

  private rest(target: number) {
    this.position = target;
    this.velocity = 0;
    this.phase = "idle";
    if (this.anchor !== null && this.selected >= this.anchor) this.anchor = null;
    this.sequence = nextSequence();
    this.emitPosition();
    this.emitState("settled");
    if (this.leadOnRest) {
      this.leadOnRest = false;
      if (this.lead(true)) return;
    }
    this.reconcile();
  }

  private stopSpring() {
    if (this.frameId !== null) this.clock.cancelFrame(this.frameId);
    this.frameId = null;
    this.spring = null;
    const end = this.endMotion;
    this.endMotion = null;
    end?.();
  }

  private cancelMotion() {
    this.stopSpring();
    this.endTracking();
    this.leadOnRest = false;
    this.phase = "idle";
    this.velocity = 0;
  }

  private emitPosition() {
    const view = this.view;
    this.emitter.position(view.pagePosition, view.lead);
  }

  private emitState(phase: PagerStateEvent["phase"]) {
    const view = this.view;
    const event: PagerStateEvent = { phase, sequence: this.sequence, position: this.position, selected: view.atLeading ? -1 : view.home, velocity: this.velocity, leading: view.atLeading };
    if (this.order) event.profileId = this.selectedId();
    this.emitter.state(event);
  }

  private selectedId(): string | null {
    const ids = this.order;
    return !this.view.atLeading && ids && this.selected >= 0 && this.selected < ids.length ? ids[this.selected]! : null;
  }
}
