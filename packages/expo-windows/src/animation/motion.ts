import type { MotionBurst, MotionNative } from "@ardia/shell";
import { displayFrames } from "./frames";
import type { Running as Animation } from "./index";

type Running = Pick<Animation, "__active">;
type Frame = (time: number) => void;
type Follower = () => void;
type Timers = { requestAnimationFrame(frame: Frame): number; cancelAnimationFrame(id: number): void };

type BurstListener = (burst: MotionBurst) => void;
type ConsentEpoch = () => string;

export type DisplayFrame = { time: number; interval: number };

export type FrameSource = {
  request(): void;
  now(): number;
  onFrame(listener: (frame: DisplayFrame) => void): void;
};

export type FrameClock = {
  requestFrame(frame: Frame): number;
  cancelFrame(id: number): void;
  now(): number;
  interval(): number;
};

export type WallClock = { now(): number; after(ms: number, run: () => void): void };

const LONG_FRAME_INTERVALS = 2.5;
const LOST_FRAME_MS = 250;
const realWall: WallClock = { now: () => Date.now(), after: (ms, run) => void setTimeout(run, ms) };
const REPORT_AFTER_FRAMES = 3;

const report = (error: unknown) => console.error("[ardia windows] an animation frame failed", error);

export function createFrameClock(source: () => FrameSource, wall: WallClock = realWall): FrameClock {
  let waiting = new Map<number, Frame>();
  let turn = new Map<number, Frame>();
  let lastId = 0;
  let requested = false;
  let askedAt = 0;
  let watchingForLoss = false;
  let lastInterval = 0;
  let connected: FrameSource | null = null;

  const display = () => {
    if (connected) return connected;
    connected = source();
    connected.onFrame(runFrame);
    return connected;
  };

  function runFrame({ time, interval }: DisplayFrame) {
    requested = false;
    if (interval > 0) lastInterval = interval;
    turn = waiting;
    waiting = new Map();
    for (const [id, frame] of turn) {
      turn.delete(id);
      try {
        frame(time);
      } catch (error) {
        report(error);
      }
    }
    if (waiting.size) ask();
  }

  function ask() {
    if (requested) return;
    requested = true;
    askedAt = wall.now();
    display().request();
    watchForLoss(LOST_FRAME_MS);
  }

  function watchForLoss(ms: number) {
    if (watchingForLoss) return;
    watchingForLoss = true;
    wall.after(ms, () => {
      watchingForLoss = false;
      if (!requested) return;
      const quiet = wall.now() - askedAt;
      if (quiet < LOST_FRAME_MS) return watchForLoss(LOST_FRAME_MS - quiet);
      requested = false;
      if (waiting.size) ask();
    });
  }

  return {
    requestFrame(frame) {
      const id = ++lastId;
      waiting.set(id, frame);
      ask();
      return id;
    },
    cancelFrame(id) {
      waiting.delete(id);
      turn.delete(id);
    },
    now: () => display().now(),
    interval: () => lastInterval,
  };
}

export function createMotion(clock: FrameClock) {
  const running = new Set<Running>();
  const followers = new Set<Follower>();
  const burstListeners = new Map<BurstListener, ConsentEpoch>();
  let watching = false;
  let burst = { frames: 0, startedAt: 0, lastAt: 0, longest: 0, long: 0, epochs: new Map<BurstListener, string>() };

  function each<Listener>(listeners: Set<Listener>, call: (listener: Listener) => void) {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (error) {
        report(error);
      }
    }
  }

  function watch(time: number) {
    for (const animation of running) if (!animation.__active) running.delete(animation);
    burst.frames += 1;
    const gap = time - burst.lastAt;
    burst.lastAt = time;
    if (burst.frames > 1) {
      burst.longest = Math.max(burst.longest, gap);
      const interval = clock.interval();
      if (interval > 0 && gap > interval * LONG_FRAME_INTERVALS) burst.long += 1;
    }
    each(followers, (follow) => follow());
    if (running.size) return void clock.requestFrame(watch);
    watching = false;
    if (burst.frames < REPORT_AFTER_FRAMES) return;
    const ended = { frames: burst.frames, milliseconds: Math.round(time - burst.startedAt), longest: Math.round(burst.longest), long: burst.long };
    console.log(`[ardia windows] motion ${ended.frames} frames in ${ended.milliseconds} ms, longest ${ended.longest} ms, ${ended.long} long`);
    const { epochs } = burst;
    each(new Set(burstListeners.keys()), (listen) => listen({ ...ended, epoch: epochs.get(listen) ?? "" }));
  }

  return {
    noteAnimation(animation: Running) {
      running.add(animation);
      if (watching) return;
      watching = true;
      const time = clock.now();
      const epochs = new Map<BurstListener, string>();
      for (const [listen, consentEpoch] of burstListeners) epochs.set(listen, consentEpoch());
      burst = { frames: 0, startedAt: time, lastAt: time, longest: 0, long: 0, epochs };
      clock.requestFrame(watch);
    },
    forgetAnimation(animation: Running) {
      running.delete(animation);
    },
    followMotion(follow: Follower): () => void {
      followers.add(follow);
      return () => void followers.delete(follow);
    },
    onMotionBurst(listen: BurstListener, consentEpoch: ConsentEpoch): () => void {
      burstListeners.set(listen, consentEpoch);
      return () => void burstListeners.delete(listen);
    },
  };
}

export const frames = createFrameClock(displayFrames);
const motion = createMotion(frames);

export const requestFrame = frames.requestFrame;
export const cancelFrame = frames.cancelFrame;
export const { noteAnimation, forgetAnimation, followMotion, onMotionBurst } = motion;

export function installFramePacing() {
  const timers = globalThis as unknown as Timers;
  timers.requestAnimationFrame = requestFrame;
  timers.cancelAnimationFrame = cancelFrame;
}

export const windowsMotion: MotionNative = { onBurst: onMotionBurst };
