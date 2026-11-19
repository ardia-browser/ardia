import { save, savedChoice, sessionId, type ConsentToken } from "./choice";
import { captureHeld, endSession, releaseHeld } from "./client";

let lastQuitBeforeThisOne: number | null | undefined;

export function endSessionForQuit(props: Record<string, unknown>, consent: ConsentToken | null) {
  lastQuitBeforeThisOne = savedChoice().lastQuitAt;
  captureHeld("app_session_ended", props, consent);
  endSession();
}

export function reopenSessionAfterCancelledQuit() {
  if (lastQuitBeforeThisOne === undefined) return false;
  const lastQuitAt = lastQuitBeforeThisOne;
  lastQuitBeforeThisOne = undefined;
  releaseHeld(true);
  save({ sessionOpen: true, sessionId: sessionId(), lastQuitAt });
  return true;
}
