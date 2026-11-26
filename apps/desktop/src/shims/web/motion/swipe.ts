import type { SwipeEvent, SwipeStep } from "@ardia-real/ardiacore";
import type { Pager, PagerArea, PagerInput } from "./pager";
import { ardiaHost, type ArdiaHost } from "../../../host";
import { onPagerFrame, PAGER_FRAME_EVENT } from "./pagerFrames";

const START_DISTANCE = 4;
const START_DOMINANCE = 1.5;
const CANCEL_DOMINANCE = 2;
const SAMPLES = 6;
const VELOCITY_WINDOW = 0.1;
const GESTURE_GAP = 0.06;
const MIN_RELEASE_GAP = 0.025;
const CADENCE_SLACK = 2.5;
const MOMENTUM_START_WAIT = 0.1;
const MOMENTUM_RUN = 3;
const MOMENTUM_DROP = 0.85;
const MOMENTUM_STEP = 0.985;
const MOMENTUM_FLOOR = 0.45;
const RESUME_JUMP = 1.35;
const OWNED_MOMENTUM_WAIT = 0.1;
const MAX_NATIVE_DELTA = 10_000;
const MAX_NATIVE_POINT = 1_000_000;

export const SCROLL_GESTURES_CAPABILITY = "shell.scrollGestures";
export const SCROLL_GESTURE_EVENT = "onScrollGesture";
export const PAGE_SWIPE_CLAIM = "shell.pageSwipeClaim";
const MAX_TAB_ID_LENGTH = 256;

export type SwipeTarget = {
  node: () => HTMLElement | null;
  canSwipeBack: () => boolean;
  canSwipeForward: () => boolean;
  tracksUnavailableDirections: () => boolean;
  allowsVerticalMotion: () => boolean;
  isPager: () => boolean;
  pager: () => { pager: Pager; area: PagerArea } | null;
  onSwipe: (event: SwipeEvent) => void;
  tabId?: () => string | null;
};

type State = "idle" | "pending" | "tracking" | "ignored";

type Gesture = {
  state: State;
  target: SwipeTarget | null;
  hit: Element | null;
  dx: number;
  dy: number;
  direction: number;
  available: boolean;
  times: number[];
  deltas: number[];
  time: number;
  startedAt: number;
};

const targets = new Set<SwipeTarget>();
let gesture: Gesture = blank();
let prepared: SwipeTarget | null = null;
let lastEventAt = -Infinity;
let gapTimer: ReturnType<typeof setTimeout> | undefined;
let magnitudes: { t: number; m: number }[] = [];
let swallowing = false;
let lastMagnitude = 0;
let nativeScroll = false;
let hostClockOffset = Infinity;
let ownedMomentum = { armed: false, flowing: false, endedAt: 0, armedAt: 0 };
let pageGesture: { tabId: string; gesture: number | null; claimed: boolean } | null = null;
let gestureHost: ArdiaHost | undefined;

const SEED_FRAME = 1 / 60;

function blank(): Gesture {
  return { state: "idle", target: null, hit: null, dx: 0, dy: 0, direction: 0, available: false, times: [], deltas: [], time: 0, startedAt: Number.NaN };
}

export function addSwipeTarget(target: SwipeTarget) {
  targets.add(target);
  install();
  return () => {
    targets.delete(target);
    if (gesture.target === target) gesture = blank();
    if (prepared === target) prepared = null;
  };
}

const isPager = (t: SwipeTarget) => t.isPager();
const hasNativePager = (t: SwipeTarget) => t.isPager() && !!t.pager();

function visible(node: HTMLElement) {
  if (!node.isConnected || !node.getClientRects().length) return false;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function targetAt(x: number, y: number, hit: Element | null, tabId?: string): SwipeTarget | null {
  if (!hit) return null;
  let best: SwipeTarget | null = null;
  let bestContainer: HTMLElement | null = null;
  for (const target of targets) {
    if (tabId !== undefined && target.tabId?.() !== tabId) continue;
    const node = target.node();
    const container = node?.parentElement;
    if (!node || !container || !visible(node) || !container.contains(hit)) continue;
    const r = node.getBoundingClientRect();
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
    if (!best || (bestContainer && bestContainer !== container && bestContainer.contains(container))) {
      best = target;
      bestContainer = container;
    }
  }
  return best;
}

function contentScrolls(hit: Element | null, container: Element | null, direction: number) {
  for (let el = hit; el && el !== container; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.scrollWidth <= el.clientWidth + 0.5) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (direction > 0 ? el.scrollLeft > 0.5 : el.scrollLeft + el.clientWidth < el.scrollWidth - 0.5) return true;
  }
  return false;
}

function emit(phase: "began" | "changed" | "ended" | "cancelled", velocity: number) {
  const target = gesture.target;
  if (!target) return;
  const distance = gesture.dx * gesture.direction;
  const native = hasNativePager(target) ? target.pager() : null;
  if (native) {
    if (phase === "began" && distance !== 0) {
      const seededAt = Number.isFinite(gesture.startedAt) && gesture.startedAt < gesture.time ? Math.max(gesture.startedAt, gesture.time - SEED_FRAME) : gesture.time - SEED_FRAME;
      native.pager.input(native.area, "began", 0, gesture.direction, seededAt);
      native.pager.input(native.area, "changed", distance, gesture.direction, gesture.time);
      return;
    }
    native.pager.input(native.area, phase as PagerInput, distance, gesture.direction, gesture.time);
    return;
  }
  target.onSwipe({
    phase,
    direction: gesture.direction > 0 ? "back" : "forward",
    distance,
    dy: gesture.dy,
    velocity: velocity * gesture.direction,
    available: gesture.available,
    width: target.node()?.getBoundingClientRect().width ?? 0,
  });
}

function pagerInput(target: SwipeTarget | null, input: PagerInput, timestamp: number) {
  const native = target && hasNativePager(target) ? target.pager() : null;
  native?.pager.input(native.area, input, 0, 0, timestamp);
}

function releasePrepared(timestamp: number) {
  const target = prepared;
  prepared = null;
  pagerInput(target, "abandon", timestamp);
}

function sample(time: number, dx: number) {
  gesture.times.push(time);
  gesture.deltas.push(dx);
  if (gesture.times.length > SAMPLES) {
    gesture.times.shift();
    gesture.deltas.shift();
  }
}

function releaseVelocity(at: number) {
  let sum = 0;
  let oldest = at;
  gesture.times.forEach((t, k) => {
    if (at - t > VELOCITY_WINDOW) return;
    sum += gesture.deltas[k]!;
    oldest = Math.min(oldest, t);
  });
  return at - oldest > 0.004 ? sum / (at - oldest) : 0;
}

function reject() {
  gesture.state = "ignored";
  releasePrepared(gesture.time);
  return false;
}

function shouldTrack() {
  const { dx, dy, target } = gesture;
  if (!target) return false;
  const verticalIntent = isPager(target) ? 3 * START_DISTANCE : START_DISTANCE;
  if (Math.abs(dy) >= verticalIntent && CANCEL_DOMINANCE * Math.abs(dx) < Math.abs(dy)) return reject();
  const below = hasNativePager(target) ? dx === 0 : Math.abs(dx) < START_DISTANCE;
  if (below || START_DOMINANCE * Math.abs(dx) < Math.abs(dy)) return false;
  const direction = dx > 0 ? 1 : -1;
  if (contentScrolls(gesture.hit, target.node()?.parentElement ?? null, direction)) return reject();
  const available = direction > 0 ? target.canSwipeBack() : target.canSwipeForward();
  if (!available && !target.tracksUnavailableDirections()) return reject();
  gesture.direction = direction;
  gesture.available = available;
  return true;
}

export function begin(x: number, y: number, hit: Element | null, timestamp: number, tabId?: string) {
  if (gesture.state === "tracking") pagerInput(gesture.target, "abandon", timestamp);
  gesture = blank();
  pageGesture = null;
  const target = targetAt(x, y, hit, tabId);
  if (!target) {
    gesture.state = "ignored";
    releasePrepared(timestamp);
    return;
  }
  if (prepared !== target) releasePrepared(timestamp);
  gesture.state = "pending";
  gesture.target = target;
  gesture.hit = hit;
  gesture.startedAt = timestamp;
}

export function prepare(x: number, y: number, hit: Element | null, timestamp: number, tabId?: string) {
  releasePrepared(timestamp);
  const target = targetAt(x, y, hit, tabId);
  if (!target || !hasNativePager(target)) return;
  prepared = target;
  pagerInput(target, "prepare", timestamp);
}

export function update(dx: number, dy: number, timestamp: number): boolean {
  if (gesture.state !== "pending" && gesture.state !== "tracking") return false;
  if (!gesture.target) {
    reject();
    return false;
  }
  gesture.dx += dx;
  gesture.dy += dy;
  gesture.time = timestamp;
  sample(timestamp, dx);
  if (gesture.state === "pending") {
    if (!shouldTrack()) return false;
    gesture.state = "tracking";
    if (prepared === gesture.target) prepared = null;
    emit("began", 0);
    return true;
  }
  if (!isPager(gesture.target) && !gesture.target.allowsVerticalMotion() && CANCEL_DOMINANCE * Math.abs(gesture.dx) < Math.abs(gesture.dy)) {
    emit("cancelled", 0);
    gesture.state = "ignored";
    return false;
  }
  emit("changed", releaseVelocity(timestamp));
  return true;
}

export function end(cancelled: boolean, timestamp: number) {
  const tracked = gesture.state === "tracking";
  if (!tracked) {
    if (gesture.state === "pending") gesture.state = "idle";
    releasePrepared(timestamp);
    return false;
  }
  gesture.time = Math.max(gesture.time, timestamp);
  emit(cancelled ? "cancelled" : "ended", releaseVelocity(timestamp));
  gesture.state = "idle";
  return true;
}

function wheelStep(target: SwipeTarget | null, hit: Element | null, dx: number) {
  if (!target || !isPager(target)) return false;
  const back = dx > 0;
  if (contentScrolls(hit, target.node()?.parentElement ?? null, back ? 1 : -1)) return false;
  target.onSwipe({
    phase: "wheel",
    direction: back ? "back" : "forward",
    distance: Math.abs(dx),
    dy: 0,
    velocity: 0,
    available: back ? target.canSwipeBack() : target.canSwipeForward(),
    width: target.node()?.getBoundingClientRect().width ?? 0,
  });
  return true;
}

function isPrecise(e: WheelEvent) {
  if (e.deltaMode !== 0) return false;
  const legacy = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  if (legacy.wheelDeltaX === undefined || legacy.wheelDeltaY === undefined) return true;
  const ratioX = e.deltaX ? Math.abs(legacy.wheelDeltaX / e.deltaX) : 3;
  const ratioY = e.deltaY ? Math.abs(legacy.wheelDeltaY / e.deltaY) : 3;
  const discrete = (legacy.wheelDeltaX !== 0 && legacy.wheelDeltaX % 120 === 0) || (legacy.wheelDeltaY !== 0 && legacy.wheelDeltaY % 120 === 0);
  return !discrete || (Math.abs(ratioX - 3) < 0.05 && Math.abs(ratioY - 3) < 0.05 && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 120);
}

function looksLikeMomentum() {
  if (magnitudes.length < MOMENTUM_RUN + 1) return false;
  const run = magnitudes.slice(-(MOMENTUM_RUN + 1));
  for (let i = 1; i < run.length; i++) {
    const ratio = run[i]!.m / run[i - 1]!.m;
    if (!(ratio <= MOMENTUM_STEP && ratio >= MOMENTUM_FLOOR)) return false;
  }
  const peak = Math.max(...magnitudes.slice(-8).map((s) => s.m));
  return run.at(-1)!.m <= peak * MOMENTUM_DROP && peak >= 3;
}

function releaseGap() {
  if (magnitudes.length < 4) return GESTURE_GAP;
  const intervals = magnitudes.slice(1).map((m, i) => m.t - magnitudes[i]!.t).sort((x, y) => x - y);
  const median = intervals[Math.floor(intervals.length / 2)]!;
  return Math.min(GESTURE_GAP, Math.max(MIN_RELEASE_GAP, median * CADENCE_SLACK));
}

function releaseByGap() {
  gapTimer = undefined;
  if (swallowing) return;
  const ignored = gesture.state === "ignored";
  swallowing = end(false, lastEventAt);
  if (ignored) gesture.state = "idle";
  magnitudes = [];
}

function onWheel(e: WheelEvent) {
  if (e.ctrlKey || !targets.size) return;
  if (nativeScroll) {
    if (ownedMomentum.armed && !ownedMomentum.flowing && performance.now() / 1000 - ownedMomentum.armedAt > OWNED_MOMENTUM_WAIT) ownedMomentum = restingMomentum();
    if (gesture.state === "tracking" || ownedMomentum.armed) e.preventDefault();
    return;
  }
  const t = e.timeStamp / 1000;
  const shiftScrollsSideways = e.shiftKey && e.deltaX === 0;
  const scrollingDx = -(shiftScrollsSideways ? e.deltaY : e.deltaX);
  const scrollingDy = shiftScrollsSideways ? 0 : -e.deltaY;
  if (!isPrecise(e)) {
    if (Math.abs(scrollingDx) <= Math.abs(scrollingDy)) return;
    const hit = e.target instanceof Element ? e.target : null;
    if (wheelStep(targetAt(e.clientX, e.clientY, hit), hit, scrollingDx)) e.preventDefault();
    return;
  }
  const magnitude = Math.hypot(e.deltaX, e.deltaY);
  const interval = t - lastEventAt;
  const live = gesture.state !== "idle";
  let fresh = false;
  if (swallowing) {
    if (interval > MOMENTUM_START_WAIT || magnitude > Math.max(2, lastMagnitude * RESUME_JUMP)) {
      swallowing = false;
      fresh = true;
    }
  } else fresh = !live || interval > releaseGap();
  lastEventAt = t;
  lastMagnitude = magnitude;
  clearTimeout(gapTimer);
  if (swallowing) {
    e.preventDefault();
    return;
  }
  if (fresh) {
    if (gesture.state === "pending" || gesture.state === "tracking") end(false, t);
    magnitudes = [];
    const hit = e.target instanceof Element ? e.target : null;
    prepare(e.clientX, e.clientY, hit, t);
    begin(e.clientX, e.clientY, hit, t);
  }
  magnitudes.push({ t, m: magnitude });
  if (magnitudes.length > 12) magnitudes.shift();
  if (gesture.state === "tracking" && looksLikeMomentum()) {
    swallowing = end(false, t);
    magnitudes = [];
    e.preventDefault();
    return;
  }
  const handled = update(scrollingDx, scrollingDy, t);
  if (gesture.state !== "idle") gapTimer = setTimeout(releaseByGap, releaseGap() * 1000);
  if (handled) e.preventDefault();
}

type PageSwipe = { phase: "began" | "changed" | "ended" | "cancelled"; dx: number; dy: number; x?: number; y?: number; t?: number; tabId?: string; gesture?: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bounded = (value: unknown, limit: number): value is number => finite(value) && Math.abs(value) <= limit;

function hostTime(t: unknown) {
  const now = performance.now() / 1000;
  if (!finite(t) || t < 0) return now;
  hostClockOffset = Math.min(hostClockOffset, now - t);
  return t + hostClockOffset;
}

function pageSwipe(value: unknown): PageSwipe | null {
  if (!value || typeof value !== "object") return null;
  const swipe = value as Record<string, unknown>;
  if (swipe.phase !== "began" && swipe.phase !== "changed" && swipe.phase !== "ended" && swipe.phase !== "cancelled") return null;
  if (!finite(swipe.dx) || !finite(swipe.dy)) return null;
  if (swipe.phase === "began" && (!finite(swipe.x) || !finite(swipe.y))) return null;
  if (swipe.tabId !== undefined && (typeof swipe.tabId !== "string" || !swipe.tabId || swipe.tabId.length > MAX_TAB_ID_LENGTH)) return null;
  if (swipe.gesture !== undefined && (typeof swipe.gesture !== "number" || !Number.isSafeInteger(swipe.gesture) || swipe.gesture < 1)) return null;
  if (swipe.gesture !== undefined && swipe.tabId === undefined) return null;
  return swipe as PageSwipe;
}

function claimPageSwipe(page: { tabId: string; gesture: number }, claimed: boolean) {
  const host = gestureHost;
  if (!host || !host.bootstrap?.capabilities?.includes(PAGE_SWIPE_CLAIM)) return;
  void Promise.resolve()
    .then(() => host.invoke(PAGE_SWIPE_CLAIM, { gesture: page.gesture, tabId: page.tabId, claimed }))
    .catch(() => {});
}

function syncPageClaim() {
  const page = pageGesture;
  if (!page || page.gesture === null) return;
  const want = gesture.state === "tracking";
  if (want === page.claimed) return;
  page.claimed = want;
  claimPageSwipe({ tabId: page.tabId, gesture: page.gesture }, want);
}

const samePageGesture = (swipe: PageSwipe) =>
  swipe.tabId === undefined || (!!pageGesture && pageGesture.tabId === swipe.tabId && pageGesture.gesture === (swipe.gesture ?? null));

export function onPageSwipe(value: unknown, timestamp?: number) {
  const swipe = pageSwipe(value);
  if (!swipe) return;
  const t = timestamp ?? hostTime(swipe.t);
  if (swipe.phase === "began") {
    if (gesture.state === "pending" || gesture.state === "tracking") end(true, t);
    const hit = typeof document === "undefined" ? null : document.elementFromPoint(swipe.x!, swipe.y!);
    prepare(swipe.x!, swipe.y!, hit, t, swipe.tabId);
    begin(swipe.x!, swipe.y!, hit, t, swipe.tabId);
    if (swipe.tabId !== undefined && gesture.state === "pending") pageGesture = { tabId: swipe.tabId, gesture: swipe.gesture ?? null, claimed: false };
    update(swipe.dx, swipe.dy, t);
    syncPageClaim();
    return;
  }
  if (!samePageGesture(swipe)) return;
  if (swipe.phase === "changed") {
    update(swipe.dx, swipe.dy, t);
    syncPageClaim();
    return;
  }
  if (swipe.dx || swipe.dy) update(swipe.dx, swipe.dy, t);
  if (pageGesture) pageGesture.claimed = false;
  end(swipe.phase === "cancelled", t);
  pageGesture = null;
}

type GesturePhase = "none" | "mayBegin" | "began" | "changed" | "ended" | "cancelled";
type ScrollGesture = { phase: GesturePhase | "wheel"; momentum: GesturePhase; dx: number; dy: number; x: number; y: number; t?: number };
const GESTURE_PHASES: readonly string[] = ["none", "mayBegin", "began", "changed", "ended", "cancelled"];

function scrollGesture(value: unknown): ScrollGesture | null {
  if (!value || typeof value !== "object") return null;
  const g = value as Record<string, unknown>;
  if (typeof g.phase !== "string" || (g.phase !== "wheel" && !GESTURE_PHASES.includes(g.phase))) return null;
  if (typeof g.momentum !== "string" || !GESTURE_PHASES.includes(g.momentum)) return null;
  if (!bounded(g.dx, MAX_NATIVE_DELTA) || !bounded(g.dy, MAX_NATIVE_DELTA)) return null;
  if (!bounded(g.x, MAX_NATIVE_POINT) || !bounded(g.y, MAX_NATIVE_POINT)) return null;
  if (g.t !== undefined && !finite(g.t)) return null;
  return g as ScrollGesture;
}

const hitAt = (x: number, y: number) => (typeof document === "undefined" ? null : document.elementFromPoint(x, y));
const restingMomentum = () => ({ armed: false, flowing: false, endedAt: 0, armedAt: 0 });

function followMomentum(momentum: GesturePhase, t: number) {
  if (!ownedMomentum.armed) return;
  if (!ownedMomentum.flowing) {
    ownedMomentum.flowing = momentum === "began" && t - ownedMomentum.endedAt <= OWNED_MOMENTUM_WAIT;
    if (!ownedMomentum.flowing) {
      ownedMomentum = restingMomentum();
      return;
    }
  }
  if (momentum === "ended" || momentum === "cancelled") ownedMomentum = restingMomentum();
}

export function onScrollGesture(value: unknown, timestamp?: number) {
  const g = scrollGesture(value);
  if (!g) return;
  const t = timestamp ?? hostTime(g.t);
  if (g.phase === "wheel") {
    ownedMomentum = restingMomentum();
    if (Math.abs(g.dx) <= Math.abs(g.dy)) return;
    const hit = hitAt(g.x, g.y);
    wheelStep(targetAt(g.x, g.y, hit), hit, g.dx);
    return;
  }
  if (g.phase === "none") {
    followMomentum(g.momentum, t);
    return;
  }
  ownedMomentum = restingMomentum();
  if (g.phase === "mayBegin") {
    prepare(g.x, g.y, hitAt(g.x, g.y), t);
    return;
  }
  if (g.phase === "began") {
    if (gesture.state === "pending" || gesture.state === "tracking") end(true, t);
    begin(g.x, g.y, hitAt(g.x, g.y), t);
  }
  if (g.phase === "ended" || g.phase === "cancelled") {
    if (g.dx || g.dy) update(g.dx, g.dy, t);
    const tracked = end(g.phase === "cancelled", t);
    if (tracked && g.phase === "ended") ownedMomentum = { armed: true, flowing: false, endedAt: t, armedAt: performance.now() / 1000 };
    return;
  }
  update(g.dx, g.dy, t);
}

const nativeScrollFrom = (host: ArdiaHost | undefined) => !!host?.bootstrap?.capabilities?.includes(SCROLL_GESTURES_CAPABILITY);

function listenForPageSwipes(host: ArdiaHost | undefined = ardiaHost) {
  nativeScroll = nativeScrollFrom(host);
  gestureHost = host;
  return host?.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell") return;
    if (event === "onPageSwipe") onPageSwipe(payload);
    else if (event === SCROLL_GESTURE_EVENT) onScrollGesture(payload);
    else if (event === PAGER_FRAME_EVENT) onPagerFrame(payload);
  });
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  listenForPageSwipes();
}

export async function simulate(target: SwipeTarget, steps: SwipeStep[], point?: { x?: number; y?: number }) {
  const node = target.node();
  if (!node) return { error: "no node" };
  const r = node.getBoundingClientRect();
  const x = r.left + (point?.x ?? r.width / 2);
  const y = r.top + (point?.y ?? r.height / 2);
  const hit = document.elementFromPoint(x, y);
  const log: string[] = [];
  for (const step of steps) {
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    const t = performance.now() / 1000;
    const dx = step.dx ?? 0;
    const dy = step.dy ?? 0;
    switch (step.phase) {
      case "mayBegin":
        prepare(x, y, hit, t);
        break;
      case "began":
        begin(x, y, hit, t);
        update(dx, dy, t);
        break;
      case "changed":
        update(dx, dy, t);
        break;
      case "ended":
      case "cancelled":
        if (dx || dy) update(dx, dy, t);
        end(step.phase === "cancelled", t);
        break;
      case "wheel":
        wheelStep(targetAt(x, y, hit), hit, dx);
        break;
      case "swipe": {
        const back = dx > 0;
        if (back ? target.canSwipeBack() : target.canSwipeForward())
          target.onSwipe({ phase: "swipe", direction: back ? "back" : "forward", distance: 0, dy: 0, velocity: 0, available: true, width: r.width });
        break;
      }
      default:
        break;
    }
    log.push(`${step.phase}:${gesture.state}`);
  }
  return { ok: true, log };
}
