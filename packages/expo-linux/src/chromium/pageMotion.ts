export type PageMotion = { durationMs: number; rects: number[][] };

type ShowArgs = Record<string, unknown> & { key: string };
type Sender = (args: ShowArgs, windowId: string) => void;
type Moving = { motion: PageMotion; startedAt: number; sent: boolean; held: { args: ShowArgs; windowId: string } | null; timer: ReturnType<typeof setTimeout> };

const SETTLE_AFTER_MS = 34;

const moving = new Map<string, Moving>();
let send: Sender | null = null;
let lastShown: (key: string) => { args: ShowArgs; windowId: string } | null = () => null;
let motionsSent = 0;
let motionsJoinedLate = 0;
let showsHeld = 0;

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
  const from = Math.min(steps, Math.max(0, Math.floor((performance.now() - entry.startedAt) / step)));
  const rects = motion.rects.slice(from);
  return rects.length < 2 ? null : { durationMs: Math.round(motion.durationMs - from * step), rects };
}

function sendMotion(entry: Moving, base: ShowArgs, windowId: string): boolean {
  const motion = remaining(entry);
  const final = motion?.rects[motion.rects.length - 1];
  if (!send || !motion || !final) return false;
  const [x, y, width, height] = final;
  const args: ShowArgs = { ...base, x, y, width, height, motion };
  delete args.windowId;
  send(args, windowId);
  entry.sent = true;
  return true;
}

export function notePageMotion(key: string, motion: PageMotion | null): boolean {
  finish(key);
  if (!motion || motion.rects.length < 2) return false;
  const entry: Moving = { motion, startedAt: performance.now(), sent: false, held: null, timer: setTimeout(() => finish(key), motion.durationMs + SETTLE_AFTER_MS) };
  moving.set(key, entry);
  const shown = lastShown(key);
  if (shown?.args.visible === true && sendMotion(entry, shown.args, shown.windowId)) motionsSent += 1;
  return true;
}

export function holdDuringMotion(args: ShowArgs, windowId: string): boolean {
  const entry = moving.get(args.key);
  if (!entry || args.motion) return false;
  if (args.visible !== true) {
    finish(args.key);
    return false;
  }
  if (!entry.sent) {
    if (!sendMotion(entry, args, windowId)) return false;
    motionsJoinedLate += 1;
    return true;
  }
  entry.held = { args, windowId };
  showsHeld += 1;
  return true;
}

export const pageMotionState = () => ({ moving: [...moving.keys()], motionsSent, motionsJoinedLate, showsHeld });
