import { clampWheelRange, STANDARD_WHEEL_TUNING, WheelSteer } from "./wheelSteerCore";
import type { WheelAction, WheelInput, WheelPhase, WheelRange, WheelTuning } from "./wheelSteerCore";

export { STANDARD_WHEEL_TUNING, WheelSteer };
export type { WheelAction, WheelInput, WheelPhase, WheelRange, WheelTuning };

const SETTLE_DELAY_MS = 140;

type StepHandler = (direction: 1 | -1) => void;

type AnimationState = {
  raf: number;
  from: number;
  to: number;
  start: number;
  duration: number;
};

type TouchTrack = {
  id: number;
  x: number;
  y: number;
  axis: "none" | "x" | "y";
};

type AreaState = {
  host: HTMLElement;
  onStep: () => StepHandler | undefined;
  steer: WheelSteer;
  scroller: HTMLElement | null;
  range: WheelRange | null;
  glideMs: number;
  anim: AnimationState | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  touch: TouchTrack | null;
};

const areasByHost = new WeakMap<HTMLElement, AreaState>();
const areasByScroller = new WeakMap<HTMLElement, AreaState>();

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const inTransit = (area: AreaState, el: HTMLElement, range: WheelRange) =>
  area.anim !== null && (el.scrollTop < range.lo - 0.5 || el.scrollTop > range.hi + 0.5);

function stopAnim(area: AreaState) {
  if (area.anim !== null) {
    cancelAnimationFrame(area.anim.raf);
    area.anim = null;
  }
}

function stopSettle(area: AreaState) {
  if (area.settleTimer !== null) {
    clearTimeout(area.settleTimer);
    area.settleTimer = null;
  }
}

function easeDuration(area: AreaState): number {
  return area.glideMs <= 0 ? 0 : area.steer.tune.notchEaseMs;
}

function animateScrollTo(area: AreaState, el: HTMLElement, target: number, durationMs: number) {
  stopAnim(area);
  const clampedTarget = Math.max(0, target);
  if (durationMs <= 0 || Math.abs(el.scrollTop - clampedTarget) <= 0.5 || typeof requestAnimationFrame !== "function") {
    el.scrollTop = clampedTarget;
    return;
  }
  const from = el.scrollTop;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    el.scrollTop = from + (clampedTarget - from) * easeOutCubic(t);
    if (t < 1) area.anim = { raf: requestAnimationFrame(step), from, to: clampedTarget, start, duration: durationMs };
    else area.anim = null;
  };
  area.anim = { raf: requestAnimationFrame(step), from, to: clampedTarget, start, duration: durationMs };
}

function findAreaFor(el: HTMLElement): AreaState | null {
  const cached = areasByScroller.get(el);
  if (cached && areasByHost.get(cached.host) === cached) return cached;
  if (cached) areasByScroller.delete(el);
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const found = areasByHost.get(node);
    if (found) {
      areasByScroller.set(el, found);
      return found;
    }
  }
  return null;
}

function isMouseNotch(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return true;
  const ay = Math.abs(e.deltaY);
  return e.deltaX === 0 && ay >= 100 && (ay % 100 === 0 || ay % 120 === 0);
}

function resolveElement(tag: unknown): HTMLElement | null {
  if (!tag || typeof tag !== "object") return null;
  if (typeof HTMLElement !== "undefined" && tag instanceof HTMLElement) return tag;
  const getter = (tag as { getScrollableNode?: () => unknown }).getScrollableNode;
  if (typeof getter === "function") {
    const inner = getter.call(tag);
    if (typeof HTMLElement !== "undefined" && inner instanceof HTMLElement) return inner;
  }
  return null;
}

function applyAction(area: AreaState, el: HTMLElement, range: WheelRange, action: WheelAction, scheduleSettle: boolean) {
  if (action.kind === "none") return;
  if (action.kind === "place") {
    stopAnim(area);
    el.scrollTop = Math.max(0, action.y);
    stopSettle(area);
    if (scheduleSettle) {
      const clamped = clampWheelRange(range, action.y);
      if (Math.abs(clamped - action.y) > 0.5) {
        area.settleTimer = setTimeout(() => {
          area.settleTimer = null;
          if (!area.scroller || !area.range) return;
          const settled = area.steer.read({ dy: 0, phase: "ended", momentum: false, precise: true }, area.scroller.scrollTop, area.range, performance.now());
          if (settled.kind === "settle") animateScrollTo(area, area.scroller, clampWheelRange(area.range, area.scroller.scrollTop), easeDuration(area));
        }, SETTLE_DELAY_MS);
      }
    }
    return;
  }
  if (action.kind === "ease") {
    stopSettle(area);
    animateScrollTo(area, el, action.y, easeDuration(area));
    return;
  }
  if (action.kind === "move") {
    stopSettle(area);
    area.onStep()?.(action.direction);
    return;
  }
  if (action.kind === "settle") {
    stopSettle(area);
    animateScrollTo(area, el, clampWheelRange(range, el.scrollTop), easeDuration(area));
  }
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i]!.identifier === id) return list[i]!;
  return null;
}

export function attachWebWheelArea(host: HTMLElement, getOnStep: () => StepHandler | undefined): () => void {
  const area: AreaState = {
    host,
    onStep: getOnStep,
    steer: new WheelSteer(),
    scroller: null,
    range: null,
    glideMs: 420,
    anim: null,
    settleTimer: null,
    touch: null,
  };
  areasByHost.set(host, area);

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    const el = area.scroller;
    const range = area.range;
    if (!el || !range) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const precise = !isMouseNotch(e);
    if (precise && inTransit(area, el, range)) return;
    const dy = precise ? -e.deltaY : e.deltaMode === 1 ? -e.deltaY : -Math.sign(e.deltaY);
    const now = performance.now();
    const at = !precise && area.anim ? area.anim.to : el.scrollTop;
    const action = area.steer.read({ dy, phase: "none", momentum: false, precise }, at, range, now);
    applyAction(area, el, range, action, true);
  };

  const onTouchStart = (e: TouchEvent) => {
    const el = area.scroller;
    const range = area.range;
    if (!el || !range || e.touches.length !== 1) {
      if (area.touch?.axis === "y" && el && range && !inTransit(area, el, range)) {
        const action = area.steer.read({ dy: 0, phase: "cancelled", momentum: false, precise: true }, el.scrollTop, range, performance.now());
        applyAction(area, el, range, action, false);
      }
      area.touch = null;
      return;
    }
    const target = e.target as Node | null;
    if (target && !el.contains(target)) {
      area.touch = null;
      return;
    }
    const t = e.touches[0]!;
    area.touch = { id: t.identifier, x: t.clientX, y: t.clientY, axis: "none" };
    area.steer.read({ dy: 0, phase: "began", momentum: false, precise: true }, el.scrollTop, range, performance.now());
  };

  const onTouchMove = (e: TouchEvent) => {
    const track = area.touch;
    const el = area.scroller;
    const range = area.range;
    if (!track || !el || !range) return;
    const t = findTouch(e.touches, track.id);
    if (!t) return;
    const dx = t.clientX - track.x;
    const dy = t.clientY - track.y;
    if (track.axis === "none") {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      track.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (track.axis === "x") return;
    track.x = t.clientX;
    track.y = t.clientY;
    if (e.cancelable) e.preventDefault();
    if (inTransit(area, el, range)) return;
    const action = area.steer.read({ dy, phase: "changed", momentum: false, precise: true }, el.scrollTop, range, performance.now());
    applyAction(area, el, range, action, false);
  };

  const finishTouch = (phase: "ended" | "cancelled") => (e: TouchEvent) => {
    const track = area.touch;
    if (!track) return;
    if (e.changedTouches && !findTouch(e.changedTouches, track.id)) return;
    const wasY = track.axis === "y";
    area.touch = null;
    const el = area.scroller;
    const range = area.range;
    if (!wasY || !el || !range || inTransit(area, el, range)) return;
    const action = area.steer.read({ dy: 0, phase, momentum: false, precise: true }, el.scrollTop, range, performance.now());
    applyAction(area, el, range, action, false);
  };

  const onTouchEnd = finishTouch("ended");
  const onTouchCancel = finishTouch("cancelled");

  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("touchend", onTouchEnd, { passive: true });
  host.addEventListener("touchcancel", onTouchCancel, { passive: true });
  return () => {
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchCancel);
    stopAnim(area);
    stopSettle(area);
    if (area.scroller && areasByScroller.get(area.scroller) === area) areasByScroller.delete(area.scroller);
    if (areasByHost.get(host) === area) areasByHost.delete(host);
  };
}

export function glideWebScroll(tag: number, y: number, durationMs: number): boolean {
  const el = resolveElement(tag);
  if (!el) return false;
  const area = findAreaFor(el);
  if (!area) return false;
  area.scroller = el;
  stopSettle(area);
  animateScrollTo(area, el, y, durationMs);
  area.steer.glideStarted(durationMs, performance.now());
  return true;
}

export function steerWebScroll(tag: number, lo: number, hi: number, glideMs: number, canForward: boolean, canBack: boolean): boolean {
  const el = resolveElement(tag);
  if (!el) return false;
  const area = findAreaFor(el);
  if (!area) return false;
  area.scroller = el;
  area.glideMs = glideMs;
  area.range = { lo, hi, forward: canForward, back: canBack };
  const target = area.anim ? area.anim.to : el.scrollTop;
  const clamped = clampWheelRange(area.range, target);
  if (Math.abs(clamped - target) > 0.5) animateScrollTo(area, el, clamped, glideMs);
  return true;
}
