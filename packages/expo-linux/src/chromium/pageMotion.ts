export type PageMotion = { durationMs: number; rects: number[][]; elapsedMs?: number };

type ShowArgs = Record<string, unknown> & { key: string };
type Sender = (args: ShowArgs, windowId: string) => void;
type Shown = { args: ShowArgs; windowId: string };
type Moving = {
  motion: PageMotion;
  clock: () => number | null;
  started: boolean;
  sent: boolean;
  held: Shown | null;
  timer: ReturnType<typeof setTimeout>;
};

const SETTLE_AFTER_MS = 34;
const LONGEST_WAIT_TO_START_MS = 500;

const moving = new Map<string, Moving>();
let send: Sender | null = null;
let lastShown: (key: string) => Shown | null = () => null;
let motionsSent = 0;
let motionsJoinedLate = 0;
let showsHeld = 0;
let lastElapsedMs = 0;

export function connectPageMotion(sender: Sender, shownNow: typeof lastShown) {
  send = sender;
  lastShown = shownNow;
}

function finish(key: string) {
  const entry = moving.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  moving.delete(key);
  if (entry.held && send) send(entry.held.args, entry.held.windowId);
}

function remaining(entry: Moving): PageMotion | null {
  const { motion } = entry;
  const steps = motion.rects.length - 1;
  if (steps < 1 || motion.durationMs <= 0) return null;
  const step = motion.durationMs / steps;
  const elapsed = entry.clock() ?? 0;
  const from = Math.min(steps, Math.max(0, Math.floor(elapsed / step)));
  const rects = motion.rects.slice(from);
  if (rects.length < 2) return null;
  return { durationMs: Math.round(motion.durationMs - from * step), rects, elapsedMs: Math.round((elapsed - from * step) * 10) / 10 };
}

function sendMotion(entry: Moving, base: Shown): boolean {
  const motion = remaining(entry);
  const final = motion?.rects[motion.rects.length - 1];
  if (!send || !motion || !final) return false;
  const [x, y, width, height] = final;
  const args: ShowArgs = { ...base.args, x, y, width, height, motion };
  delete args.windowId;
  send(args, base.windowId);
  entry.sent = true;
  entry.held = null;
  lastElapsedMs = motion.elapsedMs ?? 0;
  return true;
}

function begin(key: string, entry: Moving) {
  if (moving.get(key) !== entry || entry.started) return;
  entry.started = true;
  const base = entry.held ?? lastShown(key);
  if (base?.args.visible === true && sendMotion(entry, base)) motionsSent += 1;
}

export function notePageMotion(key: string, motion: PageMotion | null, clock: () => number | null = () => 0, started: Promise<unknown> = Promise.resolve()): boolean {
  finish(key);
  if (!motion || motion.rects.length < 2) return false;
  const entry: Moving = {
    motion,
    clock,
    started: false,
    sent: false,
    held: null,
    timer: setTimeout(() => finish(key), motion.durationMs + LONGEST_WAIT_TO_START_MS + SETTLE_AFTER_MS),
  };
  moving.set(key, entry);
  void started.then(
    () => begin(key, entry),
    () => finish(key),
  );
  return true;
}

export function holdDuringMotion(args: ShowArgs, windowId: string): boolean {
  const entry = moving.get(args.key);
  if (!entry || args.motion) return false;
  if (args.visible !== true) {
    finish(args.key);
    return false;
  }
  if (entry.started && !entry.sent) {
    if (!sendMotion(entry, { args, windowId })) return false;
    motionsJoinedLate += 1;
    return true;
  }
  entry.held = { args, windowId };
  showsHeld += 1;
  return true;
}

export const pageMotionState = () => ({ moving: [...moving.keys()], motionsSent, motionsJoinedLate, showsHeld, lastElapsedMs });
