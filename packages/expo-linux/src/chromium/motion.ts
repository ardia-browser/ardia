import type { MotionNative } from "@ardia/shell";
import { FRAME_MS, followFrames, onFrameBurst, requestFrame } from "./frames";

type Running = { __active: boolean };
type Follower = () => void;

export { FRAME_MS };

const running = new Set<Running>();

function keepFollowing() {
  for (const animation of running) if (!animation.__active) running.delete(animation);
  if (running.size) requestFrame(keepFollowing);
}

export function noteAnimation(animation: Running) {
  const idle = running.size === 0;
  running.add(animation);
  if (idle) requestFrame(keepFollowing);
}

export function forgetAnimation(animation: Running) {
  running.delete(animation);
}

export const followMotion = (follow: Follower): (() => void) => followFrames(follow);

export const onMotionBurst = onFrameBurst;

export const linuxMotion: MotionNative = { onBurst: onMotionBurst };
