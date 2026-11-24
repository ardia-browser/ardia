import { onKeyHoldReplay } from "../../platform/keyHold";
import { noteReplayGuardExpired } from "../telemetry/inlineCompletionCounts";
import { consentToken } from "../telemetry/client";

export const REPLAY_GUARD_MS = 2000;

const replaying = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let installed = false;

const changed = () => {
  for (const listener of listeners) listener();
};

function heard(tag: number, count: number) {
  const running = replaying.get(tag);
  if (running) clearTimeout(running);
  replaying.delete(tag);
  const consent = consentToken();
  if (count > 0)
    replaying.set(
      tag,
      setTimeout(() => {
        replaying.delete(tag);
        noteReplayGuardExpired(consent);
        changed();
      }, REPLAY_GUARD_MS),
    );
  changed();
}

export const replayingInto = (tag: number | null) => tag != null && replaying.has(tag);

export function watchKeyHoldReplay(listener: () => void): () => void {
  if (!installed) {
    installed = true;
    onKeyHoldReplay(heard);
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const keyHoldReplayForCheck = { heard, replayingInto };
