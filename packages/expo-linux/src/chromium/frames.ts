import type { MotionBurst } from "@ardia/shell";
import { appWindowRealms, lastFocusedAppWindow } from "../host/acrossWindows";

type Frame = (time: number) => void;
type Realm = Window & typeof globalThis;
type Follower = () => void;
type BurstListener = (burst: MotionBurst) => void;

export const FRAME_MS = 1000 / 60;
const LONG_FRAME_MS = FRAME_MS * 2.5;
const REALM_FRAME_DEADLINE_MS = FRAME_MS * 4;
const REPORT_AFTER_FRAMES = 3;

const host = globalThis as unknown as Window;
const now = () => performance.now();

let waiting = new Map<number, Frame>();
let lastId = 0;
let scheduled: { realm: Realm | null; handle: number; deadline: ReturnType<typeof setTimeout> | null } | null = null;
const followers = new Set<Follower>();
const burstListeners = new Set<BurstListener>();
let burst = { frames: 0, startedAt: 0, lastAt: 0, longest: 0, long: 0 };
let timerFrames = 0;
let realmFrames = 0;
let missedRealmFrames = 0;

const report = (error: unknown) => console.error("[ardia linux] an animation frame failed", error);

const visible = (realm: Realm) => !realm.closed && realm.document.visibilityState === "visible";

function pacingRealm(): Realm | null {
  const preferred = lastFocusedAppWindow();
  if (preferred && visible(preferred)) return preferred;
  return appWindowRealms().find(visible) ?? null;
}

function each<Listener>(listeners: Set<Listener>, call: (listener: Listener) => void) {
  for (const listener of [...listeners]) {
    try {
      call(listener);
    } catch (error) {
      report(error);
    }
  }
}

function endBurst(time: number) {
  const ended = burst;
  burst = { frames: 0, startedAt: 0, lastAt: 0, longest: 0, long: 0 };
  if (ended.frames < REPORT_AFTER_FRAMES) return;
  const done: MotionBurst = { frames: ended.frames, milliseconds: Math.round(time - ended.startedAt), longest: Math.round(ended.longest), long: ended.long };
  each(burstListeners, (listen) => listen(done));
}

function noteFrame(time: number) {
  if (burst.frames === 0) burst.startedAt = time;
  else {
    const gap = time - burst.lastAt;
    burst.longest = Math.max(burst.longest, gap);
    if (gap > LONG_FRAME_MS) burst.long += 1;
  }
  burst.frames += 1;
  burst.lastAt = time;
}

function clearScheduled() {
  if (!scheduled) return;
  if (scheduled.realm) {
    if (!scheduled.realm.closed) scheduled.realm.cancelAnimationFrame(scheduled.handle);
  }
  else clearTimeout(scheduled.handle);
  if (scheduled.deadline !== null) clearTimeout(scheduled.deadline);
  scheduled = null;
}

function runFrame() {
  clearScheduled();
  const time = now();
  const turn = waiting;
  waiting = new Map();
  noteFrame(time);
  for (const frame of turn.values()) {
    try {
      frame(time);
    } catch (error) {
      report(error);
    }
  }
  each(followers, (follow) => follow());
  if (waiting.size) schedule();
  else endBurst(time);
}

function schedule() {
  if (scheduled) return;
  const realm = pacingRealm();
  if (realm) {
    realmFrames += 1;
    const deadline = setTimeout(() => {
      missedRealmFrames += 1;
      runFrame();
    }, REALM_FRAME_DEADLINE_MS);
    scheduled = { realm, handle: realm.requestAnimationFrame(runFrame), deadline };
    return;
  }
  timerFrames += 1;
  scheduled = { realm: null, handle: setTimeout(runFrame, FRAME_MS) as unknown as number, deadline: null };
}

export function requestFrame(frame: Frame): number {
  const id = ++lastId;
  waiting.set(id, frame);
  schedule();
  return id;
}

export function cancelFrame(id: number) {
  waiting.delete(id);
  if (waiting.size) return;
  clearScheduled();
}

export function followFrames(follow: Follower): () => void {
  followers.add(follow);
  return () => void followers.delete(follow);
}

export function onFrameBurst(listen: BurstListener): () => void {
  burstListeners.add(listen);
  return () => void burstListeners.delete(listen);
}

export const framePacing = () => ({ realmFrames, timerFrames, missedRealmFrames });

let installed = false;

export function installFrameForwarding() {
  if (installed) return;
  installed = true;
  host.requestAnimationFrame = requestFrame;
  host.cancelAnimationFrame = cancelFrame;
}
